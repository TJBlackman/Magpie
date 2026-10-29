declare module 'mux.js' {
  export namespace mp4 {
    interface TransmuxerOptions {
      remux?: boolean;
      keepOriginalTimestamps?: boolean;
      baseMediaDecodeTime?: number;
      firstSequenceNumber?: number;
    }
    interface TransmuxSegment {
      initSegment: Uint8Array;
      data: Uint8Array;
      type: 'combined' | 'video' | 'audio';
      captions?: unknown[];
      metadata?: unknown[];
      info?: unknown;
    }
    /** A track's fragment placed on the output clock: 90 kHz ticks, the audio's converted from its sample rate. */
    interface SegmentTimingInfo {
      start: { dts: number; pts: number };
      end: { dts: number; pts: number };
      baseMediaDecodeTime: number;
      prependedContentDuration: number;
    }
    class Transmuxer {
      constructor(options?: TransmuxerOptions);
      on(event: 'data', cb: (segment: TransmuxSegment) => void): void;
      on(event: 'videoSegmentTimingInfo' | 'audioSegmentTimingInfo', cb: (info: SegmentTimingInfo) => void): void;
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
