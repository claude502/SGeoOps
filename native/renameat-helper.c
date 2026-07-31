#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#if defined(__linux__)
#include <sys/syscall.h>
#endif

#define ROOT_FD 3
#define EXIT_CONFLICT 73
#define EXIT_UNAVAILABLE 78
#define EXIT_FAILURE 74
#define RENAME_NOREPLACE_FLAG 1U

static int valid_basename(const char *name) {
  size_t length;
  const unsigned char *cursor;

  if (name == NULL) {
    return 0;
  }
  length = strlen(name);
  if (length == 0 || length > 255 || strcmp(name, ".") == 0 ||
      strcmp(name, "..") == 0) {
    return 0;
  }
  for (cursor = (const unsigned char *)name; *cursor != '\0'; cursor++) {
    if (!((*cursor >= 'a' && *cursor <= 'z') ||
          (*cursor >= 'A' && *cursor <= 'Z') ||
          (*cursor >= '0' && *cursor <= '9') || *cursor == '.' ||
          *cursor == '_' || *cursor == '-')) {
      return 0;
    }
  }
  return 1;
}

static int rename_no_replace(const char *source, const char *target) {
#if defined(__APPLE__)
  return renameatx_np(ROOT_FD, source, ROOT_FD, target, RENAME_EXCL);
#elif defined(__linux__) && defined(SYS_renameat2)
  return (int)syscall(
      SYS_renameat2,
      ROOT_FD,
      source,
      ROOT_FD,
      target,
      RENAME_NOREPLACE_FLAG);
#else
  (void)source;
  (void)target;
  errno = ENOSYS;
  return -1;
#endif
}

int main(int argc, char **argv) {
  struct stat root_stat;
  struct stat source_stat;
  struct stat target_stat;

  if (argc != 3 || !valid_basename(argv[1]) || !valid_basename(argv[2]) ||
      strcmp(argv[1], argv[2]) == 0) {
    fputs("invalid anchored rename arguments\n", stderr);
    return EXIT_FAILURE;
  }
  if (fstat(ROOT_FD, &root_stat) != 0 || !S_ISDIR(root_stat.st_mode)) {
    fputs("trusted root fd is unavailable\n", stderr);
    return EXIT_FAILURE;
  }
  if (fstatat(ROOT_FD, argv[1], &source_stat, AT_SYMLINK_NOFOLLOW) != 0 ||
      !S_ISDIR(source_stat.st_mode)) {
    fputs("staging directory is unavailable\n", stderr);
    return EXIT_FAILURE;
  }
  if (rename_no_replace(argv[1], argv[2]) != 0) {
    if (errno == EEXIST || errno == ENOTEMPTY) {
      return EXIT_CONFLICT;
    }
    if (errno == ENOSYS || errno == ENOTSUP) {
      fputs("anchored no-replace rename is unsupported\n", stderr);
      return EXIT_UNAVAILABLE;
    }
    perror("anchored no-replace rename failed");
    return EXIT_FAILURE;
  }
  if (fstatat(ROOT_FD, argv[2], &target_stat, AT_SYMLINK_NOFOLLOW) != 0 ||
      !S_ISDIR(target_stat.st_mode) ||
      source_stat.st_dev != target_stat.st_dev ||
      source_stat.st_ino != target_stat.st_ino) {
    fputs("published directory identity mismatch\n", stderr);
    return EXIT_FAILURE;
  }
  if (fsync(ROOT_FD) != 0) {
    perror("trusted root fsync failed");
    return EXIT_FAILURE;
  }
  return 0;
}
