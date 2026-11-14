import { describe, expect, it } from 'vitest';
import { CARDS, chatText, cleanPlaces, digitText, emojiText, EMOJI, EMOJI_MAX, teamInput, teamOpen } from '../src/shared/chat';
import { startTimer } from '../src/shared/schedule';

describe('チャットの決まり', () => {
  it('札の文に、仲間の名前と場所の名前が入る', () => {
    expect(chatText({ kind: 'card', card: 'here' })[0]).toBe('ここにいる！');
    expect(chatText({ kind: 'card', card: 'come', person: 'ゆいか' })).toEqual(['ゆいか、一緒に来て！', 'ゆいか, COME']);
    expect(chatText({ kind: 'card', card: 'meet', place: '鴨池' })).toEqual(['鴨池で合流しよう', 'MEET AT 鴨池']);
    expect(chatText({ kind: 'card', card: 'none' })[0]).toBe('');
    expect(chatText({ kind: 'digit', text: '110' })[0]).toBe('110');
  });

  it('札の id は重ならず、選ぶ札は仲間の回線だけ', () => {
    expect(new Set(CARDS.map((c) => c.id)).size).toBe(CARDS.length);
    expect(CARDS.filter((c) => c.pick).every((c) => c.ch === 'team')).toBe(true);
  });

  it('牢屋の人は絵文字だけ（外せる）。送れない設定は誰も送れない', () => {
    expect(teamInput('card', 'emoji', false)).toBe('card');
    expect(teamInput('card', 'emoji', true)).toBe('emoji');
    expect(teamInput('digit', 'emoji', true)).toBe('emoji');
    expect(teamInput('digit', 'same', true)).toBe('digit');
    expect(teamInput('off', 'emoji', true)).toBe('off');
  });

  it('仲間の回線は、配役から時間が0になるまで', () => {
    const timer = startTimer([1000, 1000, 1000, 1000], 10_000);
    expect(teamOpen({ stage: 'lobby', timer: null }, 0)).toBe(false);
    expect(teamOpen({ stage: 'assigned', timer: null }, 0)).toBe(true);
    expect(teamOpen({ stage: 'timer', timer }, 13_000)).toBe(true);
    expect(teamOpen({ stage: 'timer', timer }, 16_001)).toBe(false);
    expect(teamOpen({ stage: 'result', timer }, 12_000)).toBe(false);
  });

  it('絵文字は札の番号で、数字は数字だけ', () => {
    expect(emojiText([0, 3])).toBe(EMOJI[0] + EMOJI[3]);
    expect(emojiText([])).toBeNull();
    expect(emojiText(Array(EMOJI_MAX + 1).fill(0))).toBeNull();
    expect(emojiText([EMOJI.length])).toBeNull();
    expect(emojiText('👍')).toBeNull();
    expect(digitText('110')).toBe('110');
    expect(digitText('1a')).toBeNull();
    expect(digitText('123456789')).toBeNull();
    expect(digitText('')).toBeNull();
  });

  it('場所の名前は、空と重なりを消して整える', () => {
    expect(cleanPlaces([' 鴨池 ', '', '鴨池', 'メディア\n裏'])).toEqual(['鴨池', 'メディア 裏']);
    expect(cleanPlaces([])).toBeNull();
    expect(cleanPlaces('鴨池')).toBeNull();
  });
});
