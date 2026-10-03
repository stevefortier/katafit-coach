// Only transient model input is resized. Backend-owned originals, fingerprints,
// consent checks and media handles are never changed or persisted here.
export async function prepareModelImage(
  data: Buffer,
  mimeType: string,
): Promise<{ data: Buffer; mimeType: string }> {
  try {
    const { default: sharp } = await import("sharp");
    const format = mimeType.slice("image/".length);
    const metadata = await sharp(data, {
      limitInputPixels: 40_000_000,
      failOn: "error",
      animated: false,
    }).metadata();
    if (
      metadata.format !== format ||
      !metadata.width ||
      !metadata.height ||
      metadata.width * metadata.height > 40_000_000 ||
      (metadata.pages ?? 1) !== 1
    )
      throw new Error("MEDIA_REJECTED");
    const pixels = metadata.width * metadata.height;
    if (data.length <= 512 * 1024 && pixels <= 1_000_000) {
      // Metadata alone can succeed for a truncated pixel stream.
      await sharp(data, {
        limitInputPixels: 40_000_000,
        failOn: "error",
      }).stats();
      return { data, mimeType };
    }
    const rotated = (metadata.orientation ?? 1) >= 5;
    const orientedWidth = rotated ? metadata.height : metadata.width;
    const orientedHeight = rotated ? metadata.width : metadata.height;
    const scale = Math.min(1, Math.sqrt(1_000_000 / pixels));
    for (const [width, quality] of [
      [1280, 80],
      [1024, 72],
      [768, 60],
      [640, 50],
    ]) {
      const image = await sharp(data, {
        limitInputPixels: 40_000_000,
        failOn: "error",
        animated: false,
      })
        .rotate()
        .resize({
          width: Math.max(
            1,
            Math.min(width, Math.floor(orientedWidth * scale)),
          ),
          height: Math.max(
            1,
            Math.min(width, Math.floor(orientedHeight * scale)),
          ),
          fit: "inside",
          withoutEnlargement: true,
        })
        .flatten({ background: "#ffffff" })
        .jpeg({ quality })
        .toBuffer();
      if (image.length <= 768 * 1024)
        return { data: image, mimeType: "image/jpeg" };
    }
  } catch {
    throw new Error("MEDIA_REJECTED");
  }
  throw new Error("MEDIA_REJECTED");
}
