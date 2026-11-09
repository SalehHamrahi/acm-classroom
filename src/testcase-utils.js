export function normalizeTestCases(value) {
  if (!Array.isArray(value)) throw new Error('ساختار JSON باید یک آرایه از تست‌ها باشد.');
  if (value.length > 20) throw new Error('حداکثر 20 تست قابل تعریف است.');
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`ساختار تست شماره ${index + 1} معتبر نیست.`);
    if (typeof item.input !== 'string' || typeof item.output !== 'string') throw new Error(`ورودی و خروجی تست شماره ${index + 1} باید رشته باشند.`);
    return { input: item.input, output: item.output, hidden: Boolean(item.hidden) };
  });
}
