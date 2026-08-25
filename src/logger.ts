export const logger = Object.freeze({
  step(current: number, total: number, message: string): void {
    console.log(`[${current}/${total}] ${message}`);
  },
  success(message: string): void {
    console.log(`[+] ${message}`);
  },
  info(message: string): void {
    console.log(`[i] ${message}`);
  },
  warn(message: string): void {
    console.warn(`[!] ${message}`);
  },
  error(message: string): void {
    console.error(`[-] ${message}`);
  }
});
