import { describe, expect, it } from 'vitest';
import { permBanner, permMissing, type PermSnapshot } from '../src/client/perms';

const base: PermSnapshot = {
  asked: false,
  busy: false,
  motion: 'off',
  motionNeedsTap: true,
  geo: 'off',
  geoAllowed: false,
  mic: 'unknown',
  micState: 'off',
  micLive: false,
  micSilent: false,
  wantMic: false,
};
const snap = (p: Partial<PermSnapshot>): PermSnapshot => ({ ...base, ...p });

describe('スマホの許可のバナー（1枚だけ）', () => {
  it('最初：iPhone は動き・位置・マイクをまとめてお願いする', () => {
    expect(permMissing(base)).toEqual(['motion', 'geo', 'mic']);
    const b = permBanner(base)!;
    expect(b.kind).toBe('ask');
    expect(b.usable).toBe(true);
    expect(b.compact).toBe(false);
    expect(b.sub[0]).toContain('動き・位置・マイクを使う');
  });

  it('Android で前に位置を許可していれば、並べるのはマイクだけ', () => {
    const s = snap({ motionNeedsTap: false, geoAllowed: true });
    expect(permMissing(s)).toEqual(['mic']);
    expect(permBanner(s)!.sub[0]).toBe('マイクを使う。全部「許可」');
  });

  it('全部もう許可されていれば、何も出さない（役が鬼になっても、開いている間は出さない）', () => {
    const s = snap({ motionNeedsTap: false, geoAllowed: true, mic: 'granted' });
    expect(permBanner(s)).toBeNull();
    expect(permBanner({ ...s, wantMic: true, micState: 'ready', micLive: true })).toBeNull();
  });

  it('確認が出ている間は押せない', () => {
    const b = permBanner(snap({ asked: true, busy: true }))!;
    expect(b.kind).toBe('asking');
    expect(b.usable).toBe(false);
  });

  it('押して全部許可されたら消える。逃走者はマイクを開けていなくても出さない', () => {
    expect(permBanner(snap({ asked: true, motion: 'ok', geo: 'ok', mic: 'granted' }))).toBeNull();
  });

  it('断られたものがあれば、同じ場所に小さく出て、押すと聞き直せる', () => {
    const b = permBanner(snap({ asked: true, motion: 'ok', geo: 'denied', mic: 'denied' }))!;
    expect(b.kind).toBe('denied');
    expect(b.head[0]).toBe('位置・マイクの許可がない');
    expect(b.compact).toBe(true);
    expect(b.usable).toBe(true);
  });

  it('マイクが要る場面（鬼・牢屋）で止まっていたら、同じバナーで戻す', () => {
    const ok = snap({ asked: true, motion: 'ok', geo: 'ok', mic: 'granted', wantMic: true });
    expect(permBanner({ ...ok, micState: 'ready', micLive: false })!.kind).toBe('fix');
    expect(permBanner({ ...ok, micState: 'ready', micLive: false, micSilent: true })!.head[0]).toBe('マイクに音が来ていない');
    expect(permBanner({ ...ok, micState: 'starting' })!.usable).toBe(false);
    // マイクの無いスマホには出さない（長押しの時刻だけで記録の候補に出る）
    expect(permBanner({ ...ok, mic: 'unsupported', micState: 'unsupported' })).toBeNull();
  });

  it('前から断られているマイクは、押す前でも、要る場面になったら出す', () => {
    const s = snap({ motionNeedsTap: false, geoAllowed: true, mic: 'denied' });
    expect(permBanner(s)).toBeNull();
    expect(permBanner({ ...s, wantMic: true })!.kind).toBe('denied');
  });
});
