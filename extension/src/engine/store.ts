/**
 * OPFS backed output file. Segments are appended in order so a multi GB job
 * never sits in memory. The finished file is exposed as a File for a blob URL.
 */
export class OutputFile {
  private writable: FileSystemWritableFileStream | null = null;
  private handle: FileSystemFileHandle | null = null;
  bytes = 0;

  constructor(private readonly name: string) {}

  static async dir(): Promise<FileSystemDirectoryHandle> {
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle('jobs', { create: true });
  }

  async open(): Promise<void> {
    const dir = await OutputFile.dir();
    this.handle = await dir.getFileHandle(this.name, { create: true });
    this.writable = await this.handle.createWritable({ keepExistingData: false });
  }

  async append(chunk: Uint8Array): Promise<void> {
    if (!this.writable) throw new Error('output not open');
    await this.writable.write(chunk as unknown as ArrayBufferView<ArrayBuffer>);
    this.bytes += chunk.byteLength;
  }

  async finish(): Promise<File> {
    if (!this.writable || !this.handle) throw new Error('output not open');
    await this.writable.close();
    this.writable = null;
    return this.handle.getFile();
  }

  async abort(): Promise<void> {
    try {
      await this.writable?.abort();
    } catch {
      /* ignore */
    }
    this.writable = null;
    await OutputFile.remove(this.name);
  }

  static async remove(name: string): Promise<void> {
    try {
      const dir = await OutputFile.dir();
      await dir.removeEntry(name);
    } catch {
      /* already gone */
    }
  }

  /** Delete leftovers from crashed sessions. */
  static async sweep(keep: Set<string>): Promise<void> {
    try {
      const dir = await OutputFile.dir();
      // Chrome supports async iteration of directory handles; Firefox too (111+).
      for await (const [name] of dir as unknown as AsyncIterable<[string, FileSystemHandle]>) {
        if (!keep.has(name)) await dir.removeEntry(name).catch(() => {});
      }
    } catch {
      /* OPFS unavailable */
    }
  }
}
