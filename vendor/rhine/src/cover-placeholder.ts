/** Stable archive identity shared by DOM thumbnails and canvas prints. */
export function coverPlaceholder(title: string) {
  let hash = 0;
  for (const char of title) hash = (Math.imul(hash, 31) + char.codePointAt(0)!) >>> 0;
  const colors = ["#806b4c", "#526963", "#686079", "#85594f", "#526b7a", "#747344"];
  return { color: colors[hash % colors.length], code: String(hash % 100).padStart(2, "0") };
}
