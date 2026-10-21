declare module 'mux.js' {
  export namespace mp4 {
    interface TransmuxerOptions {
      remux?: boolean;
      keepOriginalTimestamps?: boolean;
      baseMediaDecodeTime?: number;
    }
    interface TransmuxSegment {
      initSegment: Uint8Array;
      data: Uint8Array;
      type: 'combined' | 'video' | 'audio';
      captions?: unknown[];
      metadata?: unknown[];
      info?: unknown;
    }
    class Transmuxer {
      constructor(options?: TransmuxerOptions);
      on(event: 'data', cb: (segment: TransmuxSegment) => void): void;
      on(event: 'done', cb: () => void): void;
      on(event: string, cb: (...args: unknown[]) => void): void;
      off(event: string, cb?: (...args: unknown[]) => void): void;
      push(bytes: Uint8Array): void;
      flush(): void;
      reset(): void;
      setBaseMediaDecodeTime(time: number): void;
    }
  }
}
