export type PickerOption = readonly [value: string, label: string, disabled?: boolean];

export function hqSelect(label: string, items: readonly PickerOption[], value: string): HTMLSelectElement {
  const select = document.createElement('select');
  select.className = 'hq-select';
  select.setAttribute('aria-label', label);
  for (const [key, text, disabled] of items) {
    const option = new Option(text, key);
    option.disabled = disabled ?? false;
    select.add(option);
  }
  select.value = value;
  return select;
}

export function numberOptions(min: number, max: number, unit = ''): PickerOption[] {
  return Array.from({ length: max - min + 1 }, (_, i) => [String(i + min), `${i + min}${unit}`]);
}

export function pickerRow(label: string, control: HTMLElement): HTMLLabelElement {
  const row = document.createElement('label');
  row.className = 'hq-picker-row';
  const text = document.createElement('span');
  text.textContent = label;
  row.append(text, control);
  return row;
}

export type OpenDuration = (button: HTMLButtonElement, title: string, seconds: number, min: number, save: (seconds: number) => void) => void;

/** 画面に置くのは現在値1つ。開いたときだけ分・秒を選べる。 */
export function durationPicker(): { el: HTMLDialogElement; open: OpenDuration } {
  const el = document.createElement('dialog');
  el.className = 'hq-duration-dialog';
  el.innerHTML = `<form method="dialog">
    <h2 id="hq-duration-title"></h2>
    <div class="hq-duration-values"></div>
    <div class="hq-duration-actions"><button value="cancel">キャンセル</button><button value="save">適用</button></div>
  </form>`;
  el.setAttribute('aria-labelledby', 'hq-duration-title');
  const title = el.querySelector('h2')!;
  const values = el.querySelector('.hq-duration-values')!;
  const mins = hqSelect('分', numberOptions(0, 60, '分'), '0');
  const secs = hqSelect('秒', numberOptions(0, 59, '秒'), '0');
  const apply = el.querySelector<HTMLButtonElement>('[value="save"]')!;
  values.append(mins, secs);
  let min = 1;
  let onSave: ((seconds: number) => void) | null = null;
  let opener: HTMLButtonElement | null = null;
  let before = 0;
  const current = () => Number(mins.value) * 60 + Number(secs.value);
  const sync = () => {
    const atMax = mins.value === '60';
    if (atMax) secs.value = '0';
    secs.disabled = atMax;
    apply.disabled = current() < min;
  };
  mins.addEventListener('change', sync);
  secs.addEventListener('change', sync);
  el.addEventListener('close', () => {
    const save = onSave;
    onSave = null;
    if (el.returnValue === 'save' && current() !== before && current() >= min) save?.(current());
    if (opener?.isConnected) opener.focus();
    opener = null;
  });
  return { el, open(button, label, seconds, minimum, save) {
    if (el.open) return;
    opener = button;
    title.textContent = label;
    before = seconds;
    min = minimum;
    mins.value = String(Math.floor(seconds / 60));
    secs.value = String(seconds % 60);
    onSave = save;
    el.returnValue = '';
    sync();
    el.showModal();
  } };
}
