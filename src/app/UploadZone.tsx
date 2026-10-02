import { useRef, useState, type DragEvent } from 'react';
import { IconCamera, IconFiles } from './Icons';
import { isPdf } from '../ocr/pdf';

interface Props {
  onFiles: (files: File[]) => void;
  compact?: boolean;
}

const isImage = (f: File) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|bmp)$/i.test(f.name);
/** Фото или PDF (PDF раскладывается на страницы в App) */
const accepted = (f: File) => isImage(f) || isPdf(f);

export function UploadZone({ onFiles, compact }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const camRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const take = (list: FileList | null) => {
    if (!list) return;
    const files = Array.from(list).filter(accepted);
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
          <div className="upload__title">Перетащите сюда фото или PDF накладных</div>
          <div className="upload__hint">JPG, PNG или PDF, можно сразу несколько. Снимайте лист целиком, ровно сверху и при хорошем свете.</div>
        </>
      )}
      <div className="upload__buttons">
        <button type="button" className="btn btn--primary" onClick={() => fileRef.current?.click()}>
          <IconFiles /> {compact ? 'Добавить фото или PDF' : 'Выбрать файлы'}
        </button>
        <button type="button" className="btn" onClick={() => camRef.current?.click()}>
          <IconCamera /> Сфотографировать
        </button>
      </div>
      <input ref={fileRef} type="file" accept="image/*,application/pdf,.pdf" multiple hidden onChange={(e) => { take(e.target.files); e.target.value = ''; }} />
      <input ref={camRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { take(e.target.files); e.target.value = ''; }} />
    </div>
  );
}
