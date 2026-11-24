export function generateRef(): string {
  return 'CR' + Math.floor(1000 + Math.random() * 9000).toString()
}
