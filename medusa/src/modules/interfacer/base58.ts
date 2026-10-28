// Bitcoin/base58 alphabet used by Zenroom keypairoom keyrings and public keys.
export function decodeBase58(value: string): Uint8Array {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
  if (!value || value.length > 100) throw new Error("invalid_base58_key")
  const bytes: number[] = []
  for (const ch of value) {
    let carry = alphabet.indexOf(ch)
    if (carry < 0) throw new Error("invalid_base58_key")
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58
      bytes[i] = carry & 255
      carry >>= 8
    }
    while (carry) { bytes.push(carry & 255); carry >>= 8 }
  }
  for (const ch of value) { if (ch !== "1") break; bytes.push(0) }
  return Uint8Array.from(bytes.reverse())
}
