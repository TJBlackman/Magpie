/**
 * Output file for a job. Prefers OPFS so a multi GB job never sits in memory.
 * Firefox refuses OPFS in private browsing ("Security error when calling
 * GetDirectory"), and with "Always use private browsing mode" that includes the
 * extension's own background page. Then chunks are held as Blob parts and
 * joined at the end, which costs RAM equal to the file size until the save.
 */
export class OutputFile {
  private writable: FileSystemWritableFileStream | null = null;
  private handle: FileSystemFileHandle | null = null;
  private parts: Blob[] | null = null;
  bytes = 0;

  private static opfs: Promise<FileSystemDirectoryHandle | null> | null = null;

  constructor(private readonly name: string) {}

  /** The OPFS jobs directory, or null when the browser refuses OPFS here. */
  static dir(): Promise<FileSystemDirectoryHandle | null> {
    OutputFile.opfs ??= navigator.storage
      .getDirectory()
      .then((root) => root.getDirectoryHandle('jobs', { create: true }))
      .catch((e: unknown) => {
        console.warn('OPFS unavailable, buffering downloads in memory:', e);
        return null;
      });
    return OutputFile.opfs;
  }

  /** True when this file is buffered in memory instead of OPFS. */
  get inMemory(): boolean {
    return this.parts !== null;
  }

  async open(): Promise<void> {
    const dir = await OutputFile.dir();
    if (!dir) {
      this.parts = [];
      return;
    }
    this.handle = await dir.getFileHandle(this.name, { create: true });
    this.writable = await this.handle.createWritable({ keepExistingData: false });
  }

  async append(chunk: Uint8Array): Promise<void> {
    if (this.parts) {
      // Blob copies the bytes, so callers may reuse their buffer.
      this.parts.push(new Blob([chunk as unknown as ArrayBufferView<ArrayBuffer>]));
    } else {
      if (!this.writable) throw new Error('output not open');
      await this.writable.write(chunk as unknown as ArrayBufferView<ArrayBuffer>);
    }
    this.bytes += chunk.byteLength;
  }

  async finish(): Promise<File> {
    if (this.parts) {
      const file = new File(this.parts, this.name);
      this.parts = [];
      return file;
    }
    if (!this.writable || !this.handle) throw new Error('output not open');
    await this.writable.close();
    this.writable = null;
    return this.handle.getFile();
  }

  async abort(): Promise<void> {
    if (this.parts) {
      this.parts = [];
      return;
    }
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
      await dir?.removeEntry(name);
    } catch {
      /* already gone */
    }
  }

  /** Delete leftovers from crashed sessions. */
  static async sweep(keep: Set<string>): Promise<void> {
    try {
      const dir = await OutputFile.dir();
      if (!dir) return;
      // Chrome supports async iteration of directory handles; Firefox too (111+).
      for await (const [name] of dir as unknown as AsyncIterable<[string, FileSystemHandle]>) {
        if (!keep.has(name)) await dir.removeEntry(name).catch(() => {});
      }
    } catch {
      /* OPFS unavailable */
    }
  }
}
