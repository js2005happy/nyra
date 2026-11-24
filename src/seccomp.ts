// src/seccomp.ts — M4（OpenMausBot 的 bot-box 纵深借鉴）：seccomp 系统调用拒单。
//
// 只 Linux x86-64。经典 BPF（cBPF）程序：先核 arch，再把拒单里的系统
// 调用号逐个比对，命中返回 EPERM，其余放行。bwrap 用 --seccomp <fd>
// 在子进程启动时加载一次。
// 只拒“逃出盒子 / 提权 / 内核攻击面”的调用，不拒正常干活要用的：
// - 不拒 clone3（现代运行时线程/进程派生用它，bwrap 的 user+pid 命名空间
//   已经把它关在盒子里了）；
// - 不拒 unshare（盒子里的挂载命名空间本来就是私有的，再 unshare 一个
//   也逃不出去，嵌套沙箱工具还要用它）。
// - 不拒 openat/read/write/execve 等日常调用——拒单是纵深，不是断网断手。
import { arch, platform } from "node:os";

// x86-64 系统调用号（asm/unistd_64.h）。只列拒单里的，数字写死在这里、
// 测试里逐个核对，别散落在各处。
export const SECCOMP_DENIED_SYSCALLS: { nr: number; name: string }[] = [
  { nr: 101, name: "ptrace" }, // 调试别的进程
  { nr: 127, name: "create_module" },
  { nr: 155, name: "pivot_root" },
  { nr: 161, name: "chroot" },
  { nr: 163, name: "acct" },
  { nr: 165, name: "mount" },
  { nr: 166, name: "umount2" },
  { nr: 167, name: "swapon" },
  { nr: 168, name: "swapoff" },
  { nr: 169, name: "reboot" },
  { nr: 170, name: "sethostname" },
  { nr: 171, name: "setdomainname" },
  { nr: 172, name: "iopl" },
  { nr: 173, name: "ioperm" },
  { nr: 175, name: "init_module" },
  { nr: 176, name: "delete_module" },
  { nr: 178, name: "query_module" },
  { nr: 246, name: "kexec_load" },
  { nr: 248, name: "add_key" },
  { nr: 249, name: "request_key" },
  { nr: 250, name: "keyctl" },
  { nr: 298, name: "perf_event_open" },
  { nr: 308, name: "setns" }, // 加入宿主的命名空间
  { nr: 313, name: "finit_module" },
  { nr: 317, name: "seccomp" }, // 不许再套一层 filter 绕过
  { nr: 320, name: "kexec_file_load" },
  { nr: 321, name: "bpf" },
  { nr: 323, name: "userfaultfd" },
  { nr: 428, name: "open_tree" },
  { nr: 429, name: "move_mount" },
  { nr: 430, name: "fsopen" },
  { nr: 431, name: "fsconfig" },
  { nr: 432, name: "fsmount" },
  { nr: 433, name: "fspick" },
  { nr: 442, name: "mount_setattr" },
];

const AUDIT_ARCH_X86_64 = 0xc000003e;
const SECCOMP_RET_ALLOW = 0x7fff0000;
const SECCOMP_RET_ERRNO = 0x00050000;
const EPERM = 1;

// sock_filter 是 8 字节：code(u16) jt(u8) jf(u8) k(u32)。
// BPF_LD|BPF_W|BPF_ABS = 0x20；BPF_JMP|BPF_JEQ|BPF_K = 0x15；BPF_RET|BPF_K = 0x06。
function stmt(code: number, jt: number, jf: number, k: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeUInt16LE(code, 0);
  b.writeUInt8(jt, 2);
  b.writeUInt8(jf, 3);
  b.writeUInt32LE(k >>> 0, 4);
  return b;
}

/** 经典 BPF 拒单程序。非 x86-64 的 arch 直接放行（本程序只按 x86-64 号表写）。 */
export function seccompProgram(): Buffer {
  const parts: Buffer[] = [
    // arch != x86_64 → 下一条就是 ALLOW（跳 1 步到 LD nr 前？不：
    // JEQ 为真跳 1 到 LD nr；为假跳 0 落到 RET ALLOW）。
    stmt(0x20, 0, 0, 4), // LD W ABS arch
    stmt(0x15, 1, 0, AUDIT_ARCH_X86_64), // JEQ x86_64
    stmt(0x06, 0, 0, SECCOMP_RET_ALLOW), // RET ALLOW
    stmt(0x20, 0, 0, 0), // LD W ABS nr
  ];
  for (const s of SECCOMP_DENIED_SYSCALLS) {
    // 相等跳 0 步落到 RET EPERM；不等跳 1 步到下一条比对。
    parts.push(stmt(0x15, 0, 1, s.nr));
    parts.push(stmt(0x06, 0, 0, SECCOMP_RET_ERRNO | EPERM));
  }
  parts.push(stmt(0x06, 0, 0, SECCOMP_RET_ALLOW));
  return Buffer.concat(parts);
}

/** 与 seccompProgram 同款，名字按调用方习惯留着。 */
export function seccompBytes(): Buffer {
  return seccompProgram();
}

/** 本机能不能用 seccomp 拒单：只 Linux x86-64。 */
export function seccompSupported(): boolean {
  return platform() === "linux" && arch() === "x64";
}
