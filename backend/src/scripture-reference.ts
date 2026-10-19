export const BOOK_NAMES = ['Genesis','Exodus','Leviticus','Numbers','Deuteronomy','Joshua','Judges','Ruth','1 Samuel','2 Samuel','1 Kings','2 Kings','1 Chronicles','2 Chronicles','Ezra','Nehemiah','Esther','Job','Psalms','Proverbs','Ecclesiastes','Song of Solomon','Isaiah','Jeremiah','Lamentations','Ezekiel','Daniel','Hosea','Joel','Amos','Obadiah','Jonah','Micah','Nahum','Habakkuk','Zephaniah','Haggai','Zechariah','Malachi','Matthew','Mark','Luke','John','Acts','Romans','1 Corinthians','2 Corinthians','Galatians','Ephesians','Philippians','Colossians','1 Thessalonians','2 Thessalonians','1 Timothy','2 Timothy','Titus','Philemon','Hebrews','James','1 Peter','2 Peter','1 John','2 John','3 John','Jude','Revelation'];
const ABBREVIATIONS = ['gen ge gn','ex exod','lev lv','num nm','deut dt','josh jos','judg jdg','ru','1 sam 1 sa','2 sam 2 sa','1 kgs 1 ki','2 kgs 2 ki','1 chr 1 ch','2 chr 2 ch','ezr','neh ne','est es','jb','ps psalm psa','prov pr','eccl ecc','song songs sos canticles','isa is','jer je','lam la','ezek ez','dan dn','hos ho','jl','am','obad ob','jon','mic mi','nah na','hab hb','zeph zep','hag hg','zech zec','mal ml','matt mt','mk mr','lk lu','jn joh','ac act','rom ro','1 cor 1 co','2 cor 2 co','gal ga','eph ep','phil php','col','1 thess 1 th','2 thess 2 th','1 tim 1 ti','2 tim 2 ti','tit','phlm phm','heb he','jas jm','1 pet 1 pe','2 pet 2 pe','1 jn','2 jn','3 jn','jud','rev revelation revelations'];
const aliases: Array<{ book: number; alias: string }> = [];
for (let i = 0; i < BOOK_NAMES.length; i++) {
  aliases.push({ book: i + 1, alias: BOOK_NAMES[i].toLowerCase() });
  for (const alias of ABBREVIATIONS[i].match(/(?:[123] )?[a-z]+/g) ?? []) aliases.push({ book: i + 1, alias });
}
aliases.sort((a, b) => b.alias.length - a.alias.length);
const numbers: Record<string, number> = { one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,sixteen:16,seventeen:17,eighteen:18,nineteen:19,twenty:20,thirty:30,forty:40,fifty:50,sixty:60,seventy:70,eighty:80,ninety:90 };
function normalizeSpokenNumbers(text: string) {
  let value = text.toLowerCase().replace(/\bfirst\b/g, '1').replace(/\bsecond\b/g, '2').replace(/\bthird\b/g, '3');
  const pattern = new RegExp(`\\b(?:${Object.keys(numbers).join('|')}|hundred)(?:[ -]+(?:${Object.keys(numbers).join('|')}|hundred|and))*\\b`, 'g');
  value = value.replace(pattern, phrase => {
    let total = 0;const groups:number[]=[];
    for (const word of phrase.split(/[ -]+/)) {
      if(word==='and')continue;
      if(word==='hundred'){total=Math.max(1,total)*100;continue;}
      const n=numbers[word]??0;
      if(total && !(total%100===0 || (total%100>=20 && total%10===0 && n<10))){groups.push(total);total=0;}
      total+=n;
    }
    return [...groups,total].join(' ');
  });
  return value.replace(/([123])(?=[a-z])/g, '$1 ').replace(/\s+/g, ' ').trim();
}
export function normalizeReference(text: string) { return normalizeSpokenNumbers(text).replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim(); }
export interface ParsedReference { book: number; chapter?: number; verse?: number; endVerse?: number; complete: boolean }
const SINGLE_CHAPTER_BOOKS = new Set([31,57,63,64,65]);
const spokenNumber = /^(\d+)(?![\p{L}\p{N}])/u;

/** Parse only a citation's own numeric tail, never a following book's ordinal. */
function spokenTail(book: number, tail: string): (Omit<ParsedReference, 'book'> & { invalid: boolean }) | null {
  const prefix = /^[\s,.]*(?:(chapter|verses?|v)\b[\s,]*)?/.exec(tail)!;
  let rest = tail.slice(prefix[0].length);
  const first = spokenNumber.exec(rest);
  if (!first) return null;
  let chapter = Number(first[1]), verse: number | undefined, endVerse: number | undefined;
  rest = rest.slice(first[0].length);
  const separator = /^(?:\s*:\s*|[\s,]*(?:and\s+)?(?:verses?|v)\b[\s,]*|[\s,]+)/.exec(rest);
  let pending = false, invalid = false;
  if (separator) {
    const next = spokenNumber.exec(rest.slice(separator[0].length));
    if (next) {
      verse = Number(next[1]);
      rest = rest.slice(separator[0].length + next[0].length);
    } else if (separator[0].trim()) {
      // A trailing colon/"verse" is a partial citation, not a publishable one.
      pending = true;
      rest = rest.slice(separator[0].length);
      if (/^(?:\d|zero\b)/.test(rest)) return null;
    }
  }
  const explicitVerse = prefix[1] && prefix[1] !== 'chapter';
  if (explicitVerse && (!SINGLE_CHAPTER_BOOKS.has(book) || verse !== undefined)) return null;
  if (verse === undefined && SINGLE_CHAPTER_BOOKS.has(book) && prefix[1] !== 'chapter') {
    verse = chapter; chapter = 1;
  }
  const range = /^\s*(?:[-–—]|to\b|through\b)\s*/.exec(rest);
  if (range) {
    const last = spokenNumber.exec(rest.slice(range[0].length));
    if (last) {
      if (verse === undefined) return null; // Chapter ranges need operator review.
      endVerse = Number(last[1]);
      rest = rest.slice(range[0].length + last[0].length);
    } else {
      pending = true;
      rest = rest.slice(range[0].length);
      if (/^(?:\d|zero\b)/.test(rest)) return null;
    }
  }
  if (chapter < 1 || chapter > 150 || (SINGLE_CHAPTER_BOOKS.has(book) && chapter !== 1)) return null;
  if (verse !== undefined && (verse < 1 || verse > 200)) return null;
  if (endVerse !== undefined && (endVerse < 1 || endVerse > 200 || verse === undefined || endVerse < verse)) return null;
  // Do not publish a truncated first verse from a list, cross-chapter range or
  // malformed citation. Sentence punctuation followed by prose or a new exact
  // book span remains harmless, but punctuation plus another number is not.
  const moreNumbers = /^[\s,.;/]*(?:(?:and|or)(?=\s|\d)\s*)?(?:(?:verses?|v|to|through)(?=\s|\d)\s*)?(?:\d|zero\b)/.test(rest);
  if (moreNumbers || /^\s*(?::|[-–—]|verses?\b|v\b)/.test(rest)) { pending = true; invalid = true; }
  return { chapter, verse, endVerse, complete: verse !== undefined && !pending, invalid };
}

export function analyzeSpokenReferences(text: string): { references: ParsedReference[]; invalid: boolean; negated: boolean } {
  // Keep sentence punctuation until book spans are known. Stripping periods
  // first turns "John chapter three. John ..." into an invented "3 John".
  const value = normalizeSpokenNumbers(text);
  const candidates:Array<{start:number;end:number;book:number;alias:string}>=[];
  for (const { book, alias } of aliases) {
    const escaped = alias.replace(/ /g, '\\s*');
    const pattern=new RegExp(`(?:^|\\b)${escaped}(?=\\s|\\d|[.,;:!?+/–—-]|$)`,'g');
    for(const match of value.matchAll(pattern)) {
      const start=match.index!,end=start+match[0].length;
      // A spoken chapter/verse number cannot also be the next book's ordinal.
      if (/^[123]/.test(alias) && /\b(?:chapter|verses?|v)\s*$/.test(value.slice(0,start))) continue;
      candidates.push({start,end,book,alias});
    }
  }
  // Earliest, longest exact aliases win, including numbered canonical books.
  const books:typeof candidates=[];
  for (const candidate of candidates.sort((a,b)=>a.start-b.start || b.end-a.end)) {
    if (books.some(book=>candidate.start<book.end && candidate.end>book.start)) continue;
    books.push(candidate);
  }
  const references:ParsedReference[]=[];
  let invalid = false, negated = false;
  for (let index=0;index<books.length;index++) {
    const current=books[index];
    const tail = value.slice(current.end,books[index+1]?.start ?? value.length);
    const parsed=spokenTail(current.book,tail);
    const numeric = /^[\s,.:;/]*(?:(?:chapter|verses?|v)\b[\s,]*)?[+\-–—]?(?:\d|zero\b)/.test(tail);
    // Only exact, immediately preceding correction markers count. Negation in
    // a verse's wording ("should not perish") is not a negative citation.
    if ((parsed || numeric) && /\b(?:not|instead\s+of|rather\s+than)[\s,:;–—\-"'“”‘’]*$/.test(value.slice(0,current.start))) negated = true;
    if (parsed) {
      const { invalid: unsafe, ...reference } = parsed;
      invalid ||= unsafe;
      references.push({book:current.book,...reference});
    }
    // Preserve evidence of an invalid numeric citation so a valid quotation
    // elsewhere in this window cannot bypass it via the quote fallback.
    else if (numeric) invalid = true;
    else if (value.replace(/[.,;:!?]/g,' ').trim()===current.alias || value.replace(/[.,;:!?\s]/g,'')===current.alias.replace(/ /g,'')) {
      references.push({book:current.book,chapter:undefined,verse:undefined,endVerse:undefined,complete:false});
    }
  }
  return { references, invalid, negated };
}
export function parseReferences(text: string): ParsedReference[] { return analyzeSpokenReferences(text).references; }
export function parseReference(text: string): ParsedReference | null {return parseReferences(text)[0]??null;}
export function searchWords(text: string) { return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 40); }
export function ftsQuery(text: string) { return searchWords(text).map(word => `"${word}"*`).join(' AND '); }
