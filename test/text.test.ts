import { describe, it, expect } from 'vitest';
import { normalize, titleKey, stripDiscTokens, findYear, humanBytes, mediaTypeForExt, isLosslessExt, stem, extOf } from '../src/engine/text.js';

describe('normalize', () => {
  it('lowercases, strips diacritics + punctuation, collapses spaces', () => {
    expect(normalize('Café  del  Mar!')).toBe('cafe del mar');
  });
  it('expands & to and', () => {
    expect(normalize('AC/DC & Friends')).toBe('ac dc and friends');
  });
  it('turns underscores into spaces', () => {
    expect(normalize('The_Song_Name')).toBe('the song name');
  });
});

describe('titleKey', () => {
  it('drops the extension', () => {
    expect(titleKey('Bohemian Rhapsody.mp3')).toBe('bohemian rhapsody');
  });
  it('strips an " - Edit/Remix" suffix', () => {
    expect(titleKey('Money - Edit')).toBe('money');
    expect(titleKey('Roxanne - Remix')).toBe('roxanne');
  });
  it('strips a trailing "(Part N)"', () => {
    expect(titleKey('Echoes (Part 1)')).toBe('echoes');
  });
});

describe('stripDiscTokens', () => {
  it('removes disc/volume markers', () => {
    expect(stripDiscTokens('Pink Floyd - Echoes Cd 1')).toBe('Pink Floyd - Echoes');
    expect(stripDiscTokens('Very Best Of (volume2)')).toBe('Very Best Of');
  });
  it('removes (Remastered)/(Deluxe) edition tokens', () => {
    expect(stripDiscTokens('The Wall (Remastered)')).toBe('The Wall');
  });
});

describe('findYear', () => {
  it('finds a 4-digit year', () => expect(findYear('2007 The Song')).toBe(2007));
  it('returns the first year in a range', () => expect(findYear('1969 - 2007')).toBe(1969));
  it('returns undefined when absent', () => expect(findYear('no year here')).toBeUndefined());
});

describe('humanBytes', () => {
  it('formats sizes', () => {
    expect(humanBytes(0)).toBe('0 B');
    expect(humanBytes(500)).toBe('500 B');
    expect(humanBytes(1024)).toBe('1.0 KB');
    expect(humanBytes(1536)).toBe('1.5 KB');
    expect(humanBytes(1073741824)).toBe('1.0 GB');
  });
});

describe('extension helpers', () => {
  it('maps extensions to media types', () => {
    expect(mediaTypeForExt('mp3')).toBe('music');
    expect(mediaTypeForExt('flac')).toBe('music');
    expect(mediaTypeForExt('jpg')).toBe('image');
    expect(mediaTypeForExt('mp4')).toBe('video');
    expect(mediaTypeForExt('txt')).toBe('other');
  });
  it('identifies lossless', () => {
    expect(isLosslessExt('flac')).toBe(true);
    expect(isLosslessExt('mp3')).toBe(false);
  });
  it('stem/extOf', () => {
    expect(stem('01 - Song.mp3')).toBe('01 - Song');
    expect(extOf('01 - Song.MP3')).toBe('mp3');
    expect(extOf('noext')).toBe('');
  });
});
