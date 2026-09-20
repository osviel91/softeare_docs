/**
 * Reading a user-chosen file into bytes.
 *
 * `Blob.arrayBuffer()` would do this in one line, but the codebase supports
 * being driven in environments that predate it (and jsdom does not implement it
 * at all), so this goes through `FileReader`, which every target browser has.
 */

/** Read a chosen file (or any blob) into bytes. */
export function readFileBytes(file: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => {
      reject(reader.error ?? new Error("Could not read the file"));
    };
    reader.onload = () => {
      const { result } = reader;
      if (result instanceof ArrayBuffer) {
        resolve(new Uint8Array(result));
        return;
      }
      reject(new Error("Unexpected file contents"));
    };
    reader.readAsArrayBuffer(file);
  });
}
