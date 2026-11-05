# Makes TinyEMU execute every FENCE encoding as a full fence, as the RISC-V
# ISA requires for unsupported fm values (fence.tso is fm=1000). Edits the
# c2w Dockerfile so the patch is applied right after the pinned checkout.
import sys

path = sys.argv[1]
text = open(path).read()
anchor = "    git checkout ${TINYEMU_REPO_VERSION}\n"
assert text.count(anchor) == 1, "TinyEMU checkout not found exactly once"
patch = (
    "    git checkout ${TINYEMU_REPO_VERSION} && \\\n"
    "    grep -q 'if (insn & 0xf00fff80)' riscv_cpu_template.h && \\\n"
    "    sed -i 's/if (insn \\& 0xf00fff80)/if (0)/' riscv_cpu_template.h && \\\n"
    "    ! grep -q 0xf00fff80 riscv_cpu_template.h\n"
)
open(path, "w").write(text.replace(anchor, patch))
print("patched TinyEMU fence decoding")
