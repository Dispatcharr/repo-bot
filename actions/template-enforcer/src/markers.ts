function normalize(value: string): string {
  return value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .normalize('NFKD')
    .replace(/[^\x00-\x7F]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

export function missingMarkers(body: string, markers: string[]): string[] {
  const normalizedBody = normalize(body)
  return markers.filter(marker => {
    const normalizedMarker = normalize(marker)
    return !normalizedMarker || !normalizedBody.includes(normalizedMarker)
  })
}
