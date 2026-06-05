export const RDP_FILE_MIME = 'application/x-rdp-file';

export type ClipboardFilePayload = {
  name: string;
  size: number;
  data: Uint8Array;
  path?: string;
};

export type AdvertisedClipboardSnapshot =
  | {
      kind: 'files';
      fileKey: string;
      files: ClipboardFilePayload[];
    }
  | {
      kind: 'text';
      text: string;
    };

type ClipboardDataLike = {
  addText(mimeType: string, text: string): void;
  addBinary(mimeType: string, data: Uint8Array): void;
};

type ClipboardWasmLike<TClipboardData extends ClipboardDataLike = ClipboardDataLike> = {
  ClipboardData: new () => TClipboardData;
};

export function cloneClipboardFilePayloads(files: ClipboardFilePayload[]): ClipboardFilePayload[] {
  return files.map(file => ({
    name: file.name,
    size: file.size,
    data: new Uint8Array(file.data),
    path: file.path,
  }));
}

export function cloneAdvertisedClipboardSnapshot(
  snapshot: AdvertisedClipboardSnapshot,
): AdvertisedClipboardSnapshot {
  if (snapshot.kind === 'files') {
    return {
      kind: 'files',
      fileKey: snapshot.fileKey,
      files: cloneClipboardFilePayloads(snapshot.files),
    };
  }

  return {
    kind: 'text',
    text: snapshot.text,
  };
}

export function addClipboardFiles(
  clipboardData: ClipboardDataLike,
  files: ClipboardFilePayload[],
): void {
  const descriptors = files.map(file => ({
    name: file.name,
    size: file.size,
  }));

  clipboardData.addBinary(
    RDP_FILE_MIME,
    new TextEncoder().encode(JSON.stringify(descriptors)),
  );

  for (const file of files) {
    if (file.data.length > 0) {
      clipboardData.addBinary(file.name, file.data);
    } else if (file.path) {
      clipboardData.addBinary(file.path, new Uint8Array(0));
    }
  }
}

export function buildClipboardDataFromSnapshot<TClipboardData extends ClipboardDataLike>(
  wasm: ClipboardWasmLike<TClipboardData>,
  snapshot: AdvertisedClipboardSnapshot,
): TClipboardData {
  const clipboardData = new wasm.ClipboardData();

  if (snapshot.kind === 'files') {
    addClipboardFiles(clipboardData, cloneClipboardFilePayloads(snapshot.files));
  } else {
    clipboardData.addText('text/plain', snapshot.text);
  }

  return clipboardData;
}
