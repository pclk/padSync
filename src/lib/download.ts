/**
 * Saves `body` as a file through a temporary download link. The link is attached to the page while
 * it is clicked, and the object URL is kept for a while so a slow save sheet (iPad Safari) can
 * still read it.
 */
export function downloadFile(name: string, body: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
