/** Whether a file path is PHP source — the single shared check for PHP-specific gating (excluding it from the ts-morph graph until a real PHP symbol graph exists). */
export function isPhpFile(file: string): boolean {
  return file.endsWith(".php");
}
