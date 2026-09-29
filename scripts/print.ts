import type { ParsedDoc } from '../src/core/types';

export function printDoc(doc: ParsedDoc) {
  console.log(`format: ${doc.format} | supplier: ${doc.supplier} | №${doc.number} от ${doc.date} | items: ${doc.items.length}`);
  for (const it of doc.items) {
    const pack = it.pack ? ` (${it.pack.count}x${it.pack.size})` : '';
    console.log(
      `  ${String(it.n).padStart(2)} | ${(it.barcode ?? it.code ?? '').padEnd(13)} | ${it.name.slice(0, 42).padEnd(42)} | ` +
      `${String(it.qty).padStart(5)} ${(it.unit ?? '').padEnd(5)}${pack} | ${String(it.price).padStart(9)} | ${String(it.sum).padStart(10)} | ` +
      it.issues.map((i) => `[${i.level}] ${i.text}`).join('; '),
    );
  }
  if (doc.totals) console.log(`  totals read: qty ${doc.totals.qty} sum ${doc.totals.sum} vat ${doc.totals.vat}`);
  for (const i of doc.issues) console.log(`  [${i.level}] ${i.text}`);
}
