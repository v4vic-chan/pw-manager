/** 瀏覽器下載（薄包裝層）：以 Blob + 暫時的 <a download> 觸發，不經過任何網路與 history */

export interface DownloadFile {
  fileName: string;
  content: string;
  mimeType: string;
}

export function downloadFile({ fileName, content, mimeType }: DownloadFile): void {
  const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    // 延後釋放，確保瀏覽器已開始下載
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/** 本地時間 YYYYMMDD-HHmmss，用於檔名 */
export function fileTimestamp(epochMs: number): string {
  const date = new Date(epochMs);
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}
