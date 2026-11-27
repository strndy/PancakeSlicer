// iOS and iPadOS (every browser there runs WebKit) turn `accept` into system file types and grey out
// files whose extension has no registered type, such as .stl, .3mf or .gcode. There the picker lists
// every file and the caller's own name check rejects the wrong ones. iPadOS reports itself as a Mac.
const IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || /Mac/.test(navigator.platform) && navigator.maxTouchPoints > 1;

export function fileAccept(accept: string): string | undefined {
  return IOS ? undefined : accept;
}

type Picker = (options: object) => Promise<FileSystemFileHandle[]>;
type SavePicker = (options: object) => Promise<FileSystemFileHandle>;
const handles = new WeakMap<File, FileSystemFileHandle>();
export const fileHandle = (file: File) => handles.get(file);
export function keepHandle(file: File, handle: FileSystemFileHandle): File { handles.set(file, handle); return file; }
export const freshFile = async (handle: FileSystemFileHandle) => keepHandle(await handle.getFile(), handle);

function handleStore(mode: IDBTransactionMode): Promise<IDBObjectStore> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('file-handles', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('handles');
    open.onsuccess = () => resolve(open.result.transaction('handles', mode).objectStore('handles'));
    open.onerror = () => reject(open.error);
  });
}
const remembered = new Set<string>();
export function rememberHandle(key: string, handle: FileSystemFileHandle) {
  if (remembered.has(key)) return;
  remembered.add(key);
  handleStore('readwrite').then((store) => store.put(handle, key)).catch(() => {});
}
export async function storedHandle(key: string): Promise<FileSystemFileHandle | undefined> {
  try {
    const store = await handleStore('readonly');
    const handle = await new Promise<Permitted | undefined>((resolve) => { const q = store.get(key); q.onsuccess = () => resolve(q.result); q.onerror = () => resolve(undefined); });
    return handle && await permitted(handle, 'read') ? handle : undefined;
  } catch { return undefined; }
}
type Permitted = FileSystemFileHandle & { queryPermission?: (o: object) => Promise<string>; requestPermission?: (o: object) => Promise<string> };
export async function permitted(handle: Permitted, mode: 'read' | 'readwrite'): Promise<boolean> {
  try { return await handle.queryPermission?.({ mode }) === 'granted' || await handle.requestPermission?.({ mode }) === 'granted'; }
  catch { return false; }
}

type HandleItem = DataTransferItem & { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> };
export async function droppedFiles(data: DataTransfer): Promise<File[]> {
  const files = [...data.files], items = [...data.items].filter((i) => i.kind === 'file') as HandleItem[];
  if (items.length !== files.length || !items.every((i) => i.getAsFileSystemHandle)) return files;
  const picked = await Promise.all(items.map((i) => i.getAsFileSystemHandle!().catch(() => null)));
  return Promise.all(picked.map((h, i) => h?.kind === 'file' ? freshFile(h as FileSystemFileHandle).catch(() => files[i]) : files[i]));
}

let projectFile: { generation: number; handle: FileSystemFileHandle } | null = null;
export const projectFileHandle = (generation: number) => projectFile?.generation === generation ? projectFile.handle : undefined;
export function keepProjectFile(generation: number, handle: FileSystemFileHandle) { projectFile = { generation, handle }; }

const aborted = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';
const extensions = (accept: string) => [...new Set(accept.split(',').map((x) => x.trim()).filter((x) => x.startsWith('.')))];

export async function pickSaveFile(name: string, accept: string): Promise<FileSystemFileHandle | null | undefined> {
  const picker = (window as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
  if (!picker) return undefined;
  try { return await picker({ suggestedName: name, types: [{ accept: { 'application/octet-stream': extensions(accept) } }] }); }
  catch (e) { if (aborted(e)) return null; return undefined; }
}

export function pickFileList(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => pickFiles(accept, (files) => resolve([...files]), multiple, () => resolve([])));
}

// The input stays in the document until the picker closes: Safari can drop a detached input, and its change event with it.
export function pickFiles(accept: string, onFiles: (files: FileList | File[]) => unknown, multiple = false, onCancel?: () => void): void {
  const picker = (window as { showOpenFilePicker?: Picker }).showOpenFilePicker, list = extensions(accept);
  if (picker && !IOS && list.length) {
    picker({ id: 'files', multiple, types: [{ accept: { 'application/octet-stream': list } }] }).then(async (picked) => {
      const files = await Promise.all(picked.map(freshFile));
      if (files.length) void onFiles(files); else onCancel?.();
    }, (e) => { if (aborted(e)) onCancel?.(); else pickWithInput(accept, onFiles, multiple, onCancel); });
    return;
  }
  pickWithInput(accept, onFiles, multiple, onCancel);
}

function pickWithInput(accept: string, onFiles: (files: FileList | File[]) => unknown, multiple: boolean, onCancel?: () => void): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = multiple;
  input.hidden = true;
  const type = fileAccept(accept);
  if (type) input.accept = type;
  input.onchange = () => { input.remove(); if (input.files?.length) void onFiles(input.files); };
  input.oncancel = () => { input.remove(); onCancel?.(); };
  document.body.append(input);
  input.click();
}
