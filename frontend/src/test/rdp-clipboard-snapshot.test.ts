import { describe, expect, it } from 'vitest';
import {
  RDP_FILE_MIME,
  addClipboardFiles,
  buildClipboardDataFromSnapshot,
  cloneAdvertisedClipboardSnapshot,
  cloneClipboardFilePayloads,
  type AdvertisedClipboardSnapshot,
} from '@/lib/rdp-clipboard-snapshot';

class FakeClipboardData {
  texts: Array<{ mimeType: string; text: string }> = [];
  binaries: Array<{ mimeType: string; data: Uint8Array }> = [];

  addText(mimeType: string, text: string) {
    this.texts.push({ mimeType, text });
  }

  addBinary(mimeType: string, data: Uint8Array) {
    this.binaries.push({ mimeType, data });
  }
}

const fakeWasm = {
  ClipboardData: FakeClipboardData,
};

describe('RDP clipboard snapshot helpers', () => {
  it('exports the RDP file MIME type used by clipboard descriptors', () => {
    expect(RDP_FILE_MIME).toBe('application/x-rdp-file');
  });

  it('builds text clipboard payloads', () => {
    const data = buildClipboardDataFromSnapshot(fakeWasm, {
      kind: 'text',
      text: 'hello from mac',
    }) as FakeClipboardData;

    expect(data.texts).toEqual([{ mimeType: 'text/plain', text: 'hello from mac' }]);
    expect(data.binaries).toEqual([]);
  });

  it('builds file clipboard payloads with descriptor and file bytes', () => {
    const fileBytes = new Uint8Array([1, 2, 3]);
    const data = buildClipboardDataFromSnapshot(fakeWasm, {
      kind: 'files',
      fileKey: '/tmp/a.txt',
      files: [{ name: 'a.txt', size: 3, data: fileBytes, path: '/tmp/a.txt' }],
    }) as FakeClipboardData;

    expect(data.texts).toEqual([]);
    expect(data.binaries).toHaveLength(2);
    expect(data.binaries[0].mimeType).toBe('application/x-rdp-file');
    expect(JSON.parse(new TextDecoder().decode(data.binaries[0].data))).toEqual([
      { name: 'a.txt', size: 3 },
    ]);
    expect(data.binaries[1]).toEqual({ mimeType: 'a.txt', data: fileBytes });
  });

  it('uses lazy file path MIME entries for zero-byte file payloads with a path', () => {
    const data = buildClipboardDataFromSnapshot(fakeWasm, {
      kind: 'files',
      fileKey: '/tmp/lazy.bin',
      files: [{ name: 'lazy.bin', size: 99, data: new Uint8Array(0), path: '/tmp/lazy.bin' }],
    }) as FakeClipboardData;

    expect(data.binaries[1].mimeType).toBe('/tmp/lazy.bin');
    expect(data.binaries[1].data.byteLength).toBe(0);
  });

  it('adds descriptor entries through addClipboardFiles', () => {
    const data = new FakeClipboardData();

    addClipboardFiles(data, [
      { name: 'a.bin', size: 2, data: new Uint8Array([7, 8]), path: '/tmp/a.bin' },
    ]);

    expect(data.binaries[0].mimeType).toBe(RDP_FILE_MIME);
    expect(JSON.parse(new TextDecoder().decode(data.binaries[0].data))).toEqual([
      { name: 'a.bin', size: 2 },
    ]);
  });

  it('deep-clones file payload byte arrays', () => {
    const source = [{ name: 'a.bin', size: 2, data: new Uint8Array([7, 8]), path: '/tmp/a.bin' }];
    const clone = cloneClipboardFilePayloads(source);

    clone[0].data[0] = 99;

    expect(source[0].data[0]).toBe(7);
    expect(clone[0].data[0]).toBe(99);
  });

  it('deep-clones advertised file snapshots', () => {
    const snapshot: AdvertisedClipboardSnapshot = {
      kind: 'files',
      fileKey: '/tmp/a.bin',
      files: [{ name: 'a.bin', size: 2, data: new Uint8Array([7, 8]), path: '/tmp/a.bin' }],
    };
    const clone = cloneAdvertisedClipboardSnapshot(snapshot);

    if (clone.kind !== 'files') throw new Error('expected files snapshot');
    clone.files[0].data[0] = 99;

    expect(snapshot.files[0].data[0]).toBe(7);
  });
});
