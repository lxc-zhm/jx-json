//! jx-core：字节级单遍 JSON 重排器（pretty-printer）的 WASM 核心。
//!
//! 与 src/worker/reformat.ts 的 JS 版语义一致：扫描 UTF-8 字节流识别结构与
//! token 边界，token 原样复制，仅重排空白与缩进（2 空格）；数字保持原样、
//! 字符串不解码；折叠区间在容器开启时追加（起始行升序）、闭合回填，单行
//! 容器压缩掉。
//!
//! ABI：
//! - `jx_arena_base()` 返回竞技场基址（静态数据区之上的安全偏移，页对齐余量）。
//!   宿主把输入写到该偏移处，然后调用 `jx_format(in_off, in_len) -> header_off`。
//! - header 为 17 个 u32：
//!   [0]=status(0=ok 1..n=错误码) [1]=out_off [2]=out_len [3]=starts_off
//!   [4]=starts_len(=总行数) [5]=ends_off [6..9]=fold_{starts,ends,depths,childs}_off
//!   [10]=fold_count [11]=err_line [12]=err_col [13..16]=保留
//! - 一切缓冲在竞技场（bump 分配 + memory.grow）上分配。
//!
//! ⚠️ 竞技场必须整体位于模块静态数据区之上：线性内存与静态数据共存，
//! bump 从输入尾部向上增长，若越过静态区会用输出字节覆盖 BUMP/ANCHOR
//! 等静态变量（曾导致布局敏感的诡异损坏）。所有指针访问经 ANCHOR 派生
//!（统一 provenance），mem_base 对优化器不透明（black_box），防止只写
//! 不读的输出缓冲被当死存储删除。

#![no_std]
#![allow(static_mut_refs)]

use core::arch::wasm32::{memory_grow, memory_size};
use core::panic::PanicInfo;

#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    loop {}
}

// ---- 错误码（与 worker 侧文案一一对应）----
pub const ERR_UNEXPECTED_CHAR: u32 = 1;
pub const ERR_UNTERMINATED_STRING: u32 = 2;
pub const ERR_RAW_NEWLINE: u32 = 3;
pub const ERR_UNEXPECTED_END: u32 = 4;
pub const ERR_TRAILING_COMMA: u32 = 5;
pub const ERR_AFTER_DOC: u32 = 6;
pub const ERR_EMPTY: u32 = 7;
pub const ERR_OOM: u32 = 8;
pub const ERR_BAD_NUMBER: u32 = 9;
pub const ERR_BAD_LITERAL: u32 = 10;

const QUOTE: u8 = 34;
const BACKSLASH: u8 = 92;
const LF: u8 = 10;
const SPACE: u8 = 32;
const COLON: u8 = 58;
const COMMA: u8 = 44;
const LBRACK: u8 = 91;
const RBRACK: u8 = 93;
const LBRACE: u8 = 123;
const RBRACE: u8 = 125;

const S_VALUE: u32 = 0;
const S_KEY: u32 = 1;
const S_AFTER: u32 = 2;

const OBJ: u8 = 0;
const ARR: u8 = 1;

// 容器栈条目：type(u8) + pad + child(usize) + fold_idx(usize)
const STACK_ENTRY: usize = 12;

static mut BUMP: usize = 0;
static mut LIMIT: usize = 0;
static mut ANCHOR: u8 = 0;

/// 锚点字节在线性内存中的偏移
#[inline(always)]
fn anchor_off() -> usize {
    (&raw mut ANCHOR) as *mut u8 as usize
}

/// 指向线性内存地址 0 的基指针：由 ANCHOR 派生（同源 provenance），对优化器
/// 不透明（black_box）——输出/中间缓冲只写不读（由宿主读取），不透明化防止
/// DSE 把这些「死存储」删除。
#[inline(always)]
unsafe fn mem_base() -> *mut u8 {
    let p = (&raw mut ANCHOR).cast::<u8>();
    core::hint::black_box(p.wrapping_sub(p as usize))
}

#[inline(always)]
unsafe fn rd(i: usize) -> u8 {
    mem_base().wrapping_add(i).read()
}

#[inline(always)]
unsafe fn rd_u64(i: usize) -> u64 {
    mem_base().wrapping_add(i).cast::<u64>().read_unaligned()
}

#[inline(always)]
unsafe fn wr8(i: usize, v: u8) {
    mem_base().wrapping_add(i).write(v)
}

#[inline(always)]
unsafe fn wr32(i: usize, v: u32) {
    mem_base().wrapping_add(i).cast::<u32>().write(v)
}

#[inline(always)]
unsafe fn rd_usz(i: usize) -> usize {
    mem_base().wrapping_add(i).cast::<usize>().read()
}

#[inline(always)]
unsafe fn wr_usz(i: usize, v: usize) {
    mem_base().wrapping_add(i).cast::<usize>().write(v)
}

/// 线性内存内块拷贝（src/dst 均为偏移）
#[inline(always)]
unsafe fn copy_mem(src: usize, dst: usize, len: usize) {
    let b = mem_base();
    core::ptr::copy_nonoverlapping(
        b.wrapping_add(src) as *const u8,
        b.wrapping_add(dst) as *mut u8,
        len,
    )
}

/// 结尾对齐 8 的 bump 分配；空间不足时按页扩容。返回偏移（0 不会出现在合法
/// 分配中，可作 OOM 哨兵）。
#[inline]
unsafe fn bump(n: usize) -> usize {
    let b = BUMP;
    if b + n > LIMIT {
        let pages = memory_size(0);
        let need_pages = ((b + n) - LIMIT + 65535) / 65536 + 1;
        if memory_grow(0, need_pages) == usize::MAX {
            return 0;
        }
        LIMIT = (pages + need_pages) * 65536;
    }
    BUMP = b + ((n + 7) & !7);
    b
}

/// 竞技场基址：静态数据区之上（含 4KB 安全余量），64 字节对齐。
/// 宿主必须把输入写到该偏移处。
#[no_mangle]
pub unsafe extern "C" fn jx_arena_base() -> u32 {
    ((anchor_off() + 0x1000 + 63) & !63) as u32
}

/// 在 [from, to) 内查找字节 c，返回位置；找不到返回 to。
/// SWAR：8 字节块 XOR + 零字节探测，未对齐安全。
#[inline]
unsafe fn find_byte(mut i: usize, to: usize, c: u8) -> usize {
    let pat = (c as u64) * 0x0101_0101_0101_0101;
    while i < to && (i & 7) != 0 {
        if rd(i) == c {
            return i;
        }
        i += 1;
    }
    while i + 8 <= to {
        let x = rd_u64(i) ^ pat;
        if (x.wrapping_sub(0x0101_0101_0101_0101) & !x & 0x8080_8080_8080_8080) != 0 {
            let mut k = 0usize;
            while k < 8 {
                if rd(i + k) == c {
                    return i + k;
                }
                k += 1;
            }
        }
        i += 8;
    }
    while i < to {
        if rd(i) == c {
            return i;
        }
        i += 1;
    }
    to
}

/// JSON 数字语法：-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?；输入偏移 [from,to)。
/// 返回 None=合法，Some=非法。
#[inline]
unsafe fn check_number(from: usize, to: usize) -> bool {
    let mut k = from;
    if rd(k) == 45 {
        k += 1;
    } // -
    if k >= to {
        return false;
    }
    let c = rd(k);
    if c == 48 {
        k += 1; // 0 不允许前导零
    } else if (49..=57).contains(&c) {
        while k < to && (48..=57).contains(&rd(k)) {
            k += 1;
        }
    } else {
        return false;
    }
    if k < to && rd(k) == 46 {
        k += 1;
        if k >= to || !rd(k).is_ascii_digit() {
            return false;
        }
        while k < to && rd(k).is_ascii_digit() {
            k += 1;
        }
    }
    if k < to && (rd(k) == 101 || rd(k) == 69) {
        k += 1;
        if k < to && (rd(k) == 43 || rd(k) == 45) {
            k += 1;
        }
        if k >= to || !rd(k).is_ascii_digit() {
            return false;
        }
        while k < to && rd(k).is_ascii_digit() {
            k += 1;
        }
    }
    k == to
}

#[inline]
unsafe fn is_ws(b: u8) -> bool {
    b == SPACE || b == 9 || b == 10 || b == 13
}

/// jx_format(in_off, in_len) -> header 偏移（结果写入 header）。
/// 输入必须位于 [in_off, in_off+in_len)。
#[no_mangle]
pub unsafe extern "C" fn jx_format(in_off: usize, input_len: usize) -> usize {
    // header 紧随输入之后，arena 数据从 header + 64 开始
    let base = in_off + ((input_len + 7) & !7);
    let header = base;
    BUMP = base + 64;
    LIMIT = memory_size(0) * 65536;

    let n = input_len;

    // ---- 输出缓冲（1.5n + 64K 预估，ensure_out 兜底倍增）----
    let mut out_cap = n + (n >> 1) + (1 << 16);
    let mut out = bump(out_cap);
    if out == 0 {
        return write_err(header, ERR_OOM, in_off, in_off);
    }
    let mut out_pos = 0usize;

    // ---- 行偏移：行 i 内容 = [starts[i], ends[i])（相对输出缓冲起点）----
    let mut line_cap = if n >> 5 > 4096 { n >> 5 } else { 4096 };
    let mut starts = bump(line_cap * 4);
    let mut ends = bump(line_cap * 4);
    if starts == 0 || ends == 0 {
        return write_err(header, ERR_OOM, in_off, in_off);
    }
    let mut line_count = 0usize; // 当前行下标；总行数 = line_count + 1
    wr32(starts, 0);

    // ---- 折叠区间 ----
    let mut fold_cap = 4096usize;
    let mut f_start = bump(fold_cap * 4);
    let mut f_end = bump(fold_cap * 4);
    let mut f_depth = bump(fold_cap);
    let mut f_child = bump(fold_cap * 4);
    if f_start == 0 || f_end == 0 || f_depth == 0 || f_child == 0 {
        return write_err(header, ERR_OOM, in_off, in_off);
    }
    let mut fold_count = 0usize;

    // ---- 容器栈 ----
    let mut stack_cap = 256usize;
    let mut stack = bump(stack_cap * STACK_ENTRY);
    if stack == 0 {
        return write_err(header, ERR_OOM, in_off, in_off);
    }
    let mut depth = 0usize;

    // 反斜杠/换行全文缓存指针（usize::MAX = 未命中/耗尽，由 exhausted 区分）
    let mut bs_pos = usize::MAX;
    let mut bs_exhausted = false;
    let mut lf_pos = usize::MAX;
    let mut lf_exhausted = false;

    let mut i = 0usize;
    if n >= 3 && rd(in_off) == 0xEF && rd(in_off + 1) == 0xBB && rd(in_off + 2) == 0xBF {
        i = 3;
    }

    let mut state = S_VALUE;
    let mut pending_break = false;
    let mut after_comma = false;

    macro_rules! write_break {
        ($d:expr) => {{
            // 先保证 ends[line_count] 与 starts[line_count+1] 都有槽位再写入
            if line_count + 1 >= line_cap {
                let new_cap = line_cap * 2;
                let ns = bump(new_cap * 4);
                copy_mem(starts, ns, line_cap * 4);
                starts = ns;
                let ne = bump(new_cap * 4);
                copy_mem(ends, ne, line_cap * 4);
                ends = ne;
                line_cap = new_cap;
            }
            // 行区间含前导缩进：ends=LF 之前，starts=LF 之后（缩进首字节）
            wr32(ends + line_count * 4, out_pos as u32);
            let blen = 1 + ($d) * 2;
            ensure_out!(blen); // P0-2：断行写 LF+缩进前必须保证容量
            wr8(out + out_pos, LF);
            let mut k = 1usize;
            while k < blen {
                wr8(out + out_pos + k, SPACE);
                k += 1;
            }
            out_pos += blen;
            line_count += 1;
            wr32(starts + line_count * 4, (out_pos - blen + 1) as u32);
        }};
    }

    macro_rules! ensure_out {
        ($need:expr) => {{
            if out_pos + ($need) > out_cap {
                let grown = bump(out_cap * 2);
                if grown == 0 {
                    return write_err(header, ERR_OOM, in_off, in_off);
                }
                copy_mem(out, grown, out_pos);
                out = grown;
                out_cap *= 2;
            }
        }};
    }

    macro_rules! copy_span {
        ($from:expr, $to:expr) => {{
            let from = in_off + ($from);
            let to = in_off + ($to);
            let len = to - from;
            ensure_out!(len);
            if len <= 16 {
                let mut p = out_pos;
                let mut k = from;
                while k < to {
                    wr8(out + p, rd(k));
                    p += 1;
                    k += 1;
                }
                out_pos = p;
            } else {
                copy_mem(from, out + out_pos, len);
                out_pos += len;
            }
        }};
    }

    macro_rules! push_byte {
        ($b:expr) => {{
            ensure_out!(1);
            wr8(out + out_pos, $b);
            out_pos += 1;
        }};
    }

    // 扫描字符串闭合引号：j 为输入内偏移。返回闭合位置（输入内偏移）；
    // usize::MAX=未闭合；usize::MAX-1=裸换行
    macro_rules! scan_string_end {
        ($from:expr) => {{
            let mut res: usize = usize::MAX;
            let mut j = in_off + ($from);
            loop {
                let q = find_byte(j, in_off + n, QUOTE);
                let lf = if lf_exhausted {
                    usize::MAX
                } else if lf_pos != usize::MAX && lf_pos >= j {
                    lf_pos
                } else {
                    let p = find_byte(j, in_off + n, LF);
                    if p >= in_off + n {
                        lf_exhausted = true;
                        lf_pos = usize::MAX;
                        usize::MAX
                    } else {
                        lf_pos = p;
                        p
                    }
                };
                if lf != usize::MAX && (q >= in_off + n || lf < q) {
                    res = usize::MAX - 1;
                    break;
                }
                let bs = if bs_exhausted {
                    usize::MAX
                } else if bs_pos != usize::MAX && bs_pos >= j {
                    bs_pos
                } else {
                    let p = find_byte(j, in_off + n, BACKSLASH);
                    if p >= in_off + n {
                        bs_exhausted = true;
                        bs_pos = usize::MAX;
                        usize::MAX
                    } else {
                        bs_pos = p;
                        p
                    }
                };
                if bs == usize::MAX {
                    // 无更多转义：q 在界内即闭合
                    res = if q < in_off + n { q } else { usize::MAX };
                    break;
                }
                if q < in_off + n && bs > q {
                    res = q;
                    break;
                }
                // 转义：跳过 \x（\uXXXX 的 hex 位不含 "、\、换行）
                j = bs + 2;
                if j > in_off + n {
                    res = usize::MAX;
                    break;
                }
            }
            // 哨兵值（MAX / MAX-1）保持绝对语义，命中位置换算为输入内偏移
            if res >= usize::MAX - 1 {
                res
            } else {
                res - in_off
            }
        }};
    }

    loop {
        while i < n && is_ws(rd(in_off + i)) {
            i += 1;
        }

        if i >= n {
            if state == S_AFTER && depth == 0 {
                break;
            }
            return write_err(header, ERR_UNEXPECTED_END, in_off + n, in_off);
        }

        let b0 = rd(in_off + i);

        if state == S_AFTER {
            if b0 == COMMA && depth > 0 {
                push_byte!(COMMA);
                write_break!(depth); // 逗号后必有子项：急切写换行缩进
                after_comma = true;
                pending_break = false;
                state = if rd(stack + (depth - 1) * STACK_ENTRY) == OBJ { S_KEY } else { S_VALUE };
                i += 1;
            } else if (b0 == RBRACE && depth > 0 && rd(stack + (depth - 1) * STACK_ENTRY) == OBJ)
                || (b0 == RBRACK && depth > 0 && rd(stack + (depth - 1) * STACK_ENTRY) == ARR)
            {
                let lvl = depth - 1;
                write_break!(lvl);
                push_byte!(b0);
                let fo = rd_usz(stack + lvl * STACK_ENTRY + 8);
                if line_count > rd_usz(f_start + fo * 4) {
                    wr_usz(f_end + fo * 4, line_count);
                    wr_usz(f_child + fo * 4, rd_usz(stack + lvl * STACK_ENTRY + 4));
                }
                depth -= 1;
                state = S_AFTER;
                after_comma = false;
                i += 1;
            } else if depth == 0 {
                return write_err(header, ERR_AFTER_DOC, in_off + i, in_off);
            } else if after_comma {
                return write_err(header, ERR_TRAILING_COMMA, in_off + i, in_off);
            } else {
                return write_err(header, ERR_UNEXPECTED_CHAR, in_off + i, in_off);
            }
        } else if state == S_KEY {
            let top_is_obj = depth > 0 && rd(stack + (depth - 1) * STACK_ENTRY) == OBJ;
            if b0 == RBRACE && !after_comma && top_is_obj {
                // 空对象 {}：'{' 后直接闭合
                push_byte!(RBRACE);
                depth -= 1;
                let fo = rd_usz(stack + depth * STACK_ENTRY + 8);
                if line_count > rd_usz(f_start + fo * 4) {
                    wr_usz(f_end + fo * 4, line_count);
                    wr_usz(f_child + fo * 4, 0);
                }
                state = S_AFTER;
                i += 1;
            } else if b0 == QUOTE {
                if pending_break {
                    write_break!(depth);
                    pending_break = false;
                }
                let end = scan_string_end!(i + 1);
                if end == usize::MAX {
                    return write_err(header, ERR_UNTERMINATED_STRING, in_off + i, in_off);
                }
                if end == usize::MAX - 1 {
                    return write_err(header, ERR_RAW_NEWLINE, in_off + i, in_off);
                }
                copy_span!(i, end + 1);
                wr_usz(stack + (depth - 1) * STACK_ENTRY + 4, rd_usz(stack + (depth - 1) * STACK_ENTRY + 4) + 1);
                i = end + 1;
                while i < n && is_ws(rd(in_off + i)) {
                    i += 1;
                }
                if i >= n || rd(in_off + i) != COLON {
                    return write_err(header, ERR_UNEXPECTED_CHAR, in_off + i, in_off);
                }
                ensure_out!(2);
                wr8(out + out_pos, COLON);
                wr8(out + out_pos + 1, SPACE);
                out_pos += 2;
                i += 1;
                state = S_VALUE;
                after_comma = false;
            } else if after_comma {
                return write_err(header, ERR_TRAILING_COMMA, in_off + i, in_off);
            } else {
                return write_err(header, ERR_UNEXPECTED_CHAR, in_off + i, in_off);
            }
        } else {
            // S_VALUE
            let top_is_arr = depth > 0 && rd(stack + (depth - 1) * STACK_ENTRY) == ARR;
            if b0 == RBRACK && !after_comma && top_is_arr {
                // 空数组 []：'[' 后直接闭合
                push_byte!(RBRACK);
                depth -= 1;
                let fo = rd_usz(stack + depth * STACK_ENTRY + 8);
                if line_count > rd_usz(f_start + fo * 4) {
                    wr_usz(f_end + fo * 4, line_count);
                    wr_usz(f_child + fo * 4, 0);
                }
                state = S_AFTER;
                i += 1;
            } else if b0 == LBRACE || b0 == LBRACK {
                if pending_break {
                    write_break!(depth);
                    pending_break = false;
                }
                after_comma = false;
                if depth >= stack_cap {
                    let new_cap = stack_cap * 2;
                    let ns = bump(new_cap * STACK_ENTRY);
                    if ns == 0 {
                        return write_err(header, ERR_OOM, in_off, in_off);
                    }
                    copy_mem(stack, ns, stack_cap * STACK_ENTRY);
                    stack = ns;
                    stack_cap = new_cap;
                }
                // 折叠占位（起始行 = 当前行）
                if fold_count >= fold_cap {
                    let new_cap = fold_cap * 2;
                    let ns = bump(new_cap * 4);
                    if ns == 0 {
                        return write_err(header, ERR_OOM, in_off, in_off);
                    }
                    copy_mem(f_start, ns, fold_cap * 4);
                    f_start = ns;
                    let ne = bump(new_cap * 4);
                    if ne == 0 {
                        return write_err(header, ERR_OOM, in_off, in_off);
                    }
                    copy_mem(f_end, ne, fold_cap * 4);
                    f_end = ne;
                    let nd = bump(new_cap);
                    if nd == 0 {
                        return write_err(header, ERR_OOM, in_off, in_off);
                    }
                    copy_mem(f_depth, nd, fold_cap);
                    f_depth = nd;
                    let nc = bump(new_cap * 4);
                    if nc == 0 {
                        return write_err(header, ERR_OOM, in_off, in_off);
                    }
                    copy_mem(f_child, nc, fold_cap * 4);
                    f_child = nc;
                    fold_cap = new_cap;
                }
                wr_usz(f_start + fold_count * 4, line_count);
                wr_usz(f_end + fold_count * 4, usize::MAX);
                wr8(f_depth + fold_count, if depth < 255 { depth as u8 } else { 255 });
                wr_usz(stack + depth * STACK_ENTRY + 8, fold_count);
                fold_count += 1;

                push_byte!(b0);
                wr8(stack + depth * STACK_ENTRY, if b0 == LBRACE { OBJ } else { ARR });
                wr_usz(stack + depth * STACK_ENTRY + 4, 0);
                depth += 1;
                pending_break = true;
                state = if b0 == LBRACE { S_KEY } else { S_VALUE };
                i += 1;
            } else if b0 == QUOTE {
                if pending_break {
                    write_break!(depth);
                    pending_break = false;
                }
                let end = scan_string_end!(i + 1);
                if end == usize::MAX {
                    return write_err(header, ERR_UNTERMINATED_STRING, in_off + i, in_off);
                }
                if end == usize::MAX - 1 {
                    return write_err(header, ERR_RAW_NEWLINE, in_off + i, in_off);
                }
                copy_span!(i, end + 1);
                if top_is_arr {
                    wr_usz(stack + (depth - 1) * STACK_ENTRY + 4, rd_usz(stack + (depth - 1) * STACK_ENTRY + 4) + 1);
                }
                i = end + 1;
                state = S_AFTER;
                after_comma = false;
            } else if b0 == 45 || (b0 >= 48 && b0 <= 57) || b0 == 116 || b0 == 102 || b0 == 110 {
                // 标量：数字 / true / false / null
                if pending_break {
                    write_break!(depth);
                    pending_break = false;
                }
                let from = i;
                let mut j = i;
                while j < n {
                    let c = rd(in_off + j);
                    if (c >= 48 && c <= 57) || (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c == 45 || c == 43 || c == 46 {
                        j += 1;
                    } else {
                        break;
                    }
                }
                if j == i {
                    return write_err(header, ERR_UNEXPECTED_CHAR, in_off + i, in_off);
                }
                // 字面量/数字形状校验（与 JS 版语义一致）
                if b0 == 116 || b0 == 102 || b0 == 110 {
                    let a = in_off + from;
                    let n_ = j - from;
                    let is_lit = (n_ == 4 && rd(a) == 116 && rd(a + 1) == 114 && rd(a + 2) == 117 && rd(a + 3) == 101)
                        || (n_ == 5 && rd(a) == 102 && rd(a + 1) == 97 && rd(a + 2) == 108 && rd(a + 3) == 115 && rd(a + 4) == 101)
                        || (n_ == 4 && rd(a) == 110 && rd(a + 1) == 117 && rd(a + 2) == 108 && rd(a + 3) == 108);
                    if !is_lit {
                        return write_err(header, ERR_BAD_LITERAL, in_off + i, in_off);
                    }
                } else if !check_number(in_off + from, in_off + j) {
                    return write_err(header, ERR_BAD_NUMBER, in_off + i, in_off);
                }
                copy_span!(from, j);
                if top_is_arr {
                    wr_usz(stack + (depth - 1) * STACK_ENTRY + 4, rd_usz(stack + (depth - 1) * STACK_ENTRY + 4) + 1);
                }
                i = j;
                state = S_AFTER;
                after_comma = false;
            } else if after_comma {
                return write_err(header, ERR_TRAILING_COMMA, in_off + i, in_off);
            } else {
                return write_err(header, ERR_UNEXPECTED_CHAR, in_off + i, in_off);
            }
        }
    }

    wr32(ends + line_count * 4, out_pos as u32);

    // 压缩无效折叠（单行容器），保持 starts 升序
    let mut w = 0usize;
    let mut r = 0usize;
    while r < fold_count {
        if rd_usz(f_end + r * 4) != usize::MAX {
            if w != r {
                wr_usz(f_start + w * 4, rd_usz(f_start + r * 4));
                wr_usz(f_end + w * 4, rd_usz(f_end + r * 4));
                wr8(f_depth + w, rd(f_depth + r));
                wr_usz(f_child + w * 4, rd_usz(f_child + r * 4));
            }
            w += 1;
        }
        r += 1;
    }

    wr32(header, 0); // ok
    wr32(header + 4, out as u32);
    wr32(header + 8, out_pos as u32);
    wr32(header + 12, starts as u32);
    wr32(header + 16, (line_count + 1) as u32);
    wr32(header + 20, ends as u32);
    wr32(header + 24, f_start as u32);
    wr32(header + 28, f_end as u32);
    wr32(header + 32, f_depth as u32);
    wr32(header + 36, f_child as u32);
    wr32(header + 40, w as u32);
    wr32(header + 44, 0);
    wr32(header + 48, 0);
    header
}

/// 错误 header：status + 行列（冷路径：扫描输入统计换行换算行列，自 in_off 起）
unsafe fn write_err(header: usize, code: u32, at: usize, in_off: usize) -> usize {
    let mut line = 1usize;
    let mut line_start = in_off;
    let mut k = in_off;
    while k < at {
        if rd(k) == LF {
            line += 1;
            line_start = k + 1;
        }
        k += 1;
    }
    let col = if at >= line_start { at - line_start + 1 } else { 1 };
    wr32(header, code);
    wr32(header + 44, line as u32);
    wr32(header + 48, col as u32);
    header
}
