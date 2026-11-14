rule Symbolic_Library_Loader_Patterns {
  meta:
    description = "Patterns associated with manual ELF loaders or encrypted dlopen strings"
  strings:
    $memfd = "memfd_create" ascii
    $libc_dl = "__libc_dlopen_mode" ascii
    $elf_magic = { 7F 45 4C 46 }
  condition:
    any of them and filesize < 5MB
}
