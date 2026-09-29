import { useRef, useState, type DragEvent } from 'react';
import { IconCamera, IconFiles } from './Icons';

interface Props {
  onFiles: (files: File[]) => void;
  compact?: boolean;
}

const isImage = (f: File) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|bmp)$/i.test(f.name);

export function UploadZone({ onFiles, compact }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const camRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const take = (list: FileList | null) => {
    if (!list) return;
    const files = Array.from(list).filter(isImage);
    if (files.length) onFiles(files);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    take(e.dataTransfer.files);
  };

  return (
    <div
      className={`upload ${compact ? 'upload--compact' : ''} ${over ? 'upload--over' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      {!compact && (
        <>
          <div className="upload__title">Перетащите сюда фото накладных</div>
          <div className="upload__hint">JPG или PNG, можно сразу несколько. Снимайте лист целиком, ровно сверху и при хорошем свете.</div>
        </>
      )}
      <div className="upload__buttons">
        <button type="button" className="btn btn--primary" onClick={() => fileRef.current?.click()}>
          <IconFiles /> {compact ? 'Добавить фото' : 'Выбрать файлы'}
        </button>
        <button type="button" className="btn" onClick={() => camRef.current?.click()}>
          <IconCamera /> Сфотографировать
        </button>
      </div>
      <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => { take(e.target.files); e.target.value = ''; }} />
      <input ref={camRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { take(e.target.files); e.target.value = ''; }} />
    </div>
  );
}
