import type { CatalogIndex } from '../core/catalog';
import { summarize, money, type DocEntry } from './model';
import { IconAlert, IconCheck } from './Icons';

interface Props {
  docs: DocEntry[];
  selected?: string;
  catalog?: CatalogIndex;
  onSelect: (id: string) => void;
}

export function DocList({ docs, selected, catalog, onSelect }: Props) {
  return (
    <ul className="doclist">
      {docs.map((d) => {
        const s = d.doc ? summarize(d.doc, catalog) : undefined;
        const dup = !!d.doc?.issues.some((x) => x.kind === 'duplicate');
        const ok = s && !dup && s.errors === 0 && s.totalsOk !== false && s.missingBarcode === 0;
        const why = !s ? '' : dup ? 'Повтор уже загруженной накладной' : ok ? 'Готово к выгрузке' : s.errors ? `${s.errors} строк с ошибками` : s.missingBarcode ? `${s.missingBarcode} без штрихкода` : 'Не сходится с итогом';
        return (
          <li key={d.id}>
            <button type="button" className={`doccard ${selected === d.id ? 'doccard--active' : ''}`} onClick={() => onSelect(d.id)}>
              <img className="doccard__thumb" src={d.fileUrl} alt="" />
              <span className="doccard__body">
                <span className="doccard__title">{d.doc?.supplier ?? (d.status === 'done' ? 'Поставщик не определён' : d.fileName)}</span>
                {d.status === 'queued' && <span className="doccard__meta">В очереди…</span>}
                {d.status === 'processing' && (
                  <>
                    <span className="doccard__meta">{d.stage ?? 'Обработка'} · {Math.round(d.progress * 100)}%</span>
                    <span className="progress"><span style={{ width: `${Math.round(d.progress * 100)}%` }} /></span>
                  </>
                )}
                {d.status === 'error' && <span className="doccard__meta doccard__meta--err">Ошибка: {d.error}</span>}
                {s && d.doc && (
                  <span className="doccard__meta">
                    {dup ? 'Повтор · ' : ''}{d.doc.number ? `№ ${d.doc.number} · ` : ''}{d.doc.pages ? `${d.doc.pages} стр. · ` : ''}{s.rows} поз. · {money(s.sum)} ₸
                  </span>
                )}
              </span>
              {s && (
                <span className={`doccard__status ${ok ? 'is-ok' : s.errors || dup ? 'is-err' : 'is-warn'}`} title={why}>
                  {ok ? <IconCheck /> : <IconAlert />}
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
