import { getSchema } from '@tiptap/core';
import { MarkdownManager } from '@tiptap/markdown';
import { describe, expect, it } from 'vitest';
import { findMatches } from './find';
import { schemaExtensions } from './markdown';

const schema = getSchema(schemaExtensions());
const docOf = (markdown: string) => schema.nodeFromJSON(new MarkdownManager({ extensions: schemaExtensions() }).parse(markdown));
const words = (doc: ReturnType<typeof docOf>, query: string) => findMatches(doc, query).map((m) => doc.textBetween(m.from, m.to));

describe('find in note', () => {
  const doc = docOf('# Login\n\nRemember **SSO** for the login page.\n\n- sso again\n- Log in once');

  it('matches every place, ignoring case, across marks', () => {
    expect(words(doc, 'login')).toEqual(['Login', 'login']);
    expect(words(doc, 'remember sso')).toEqual(['Remember SSO']);
    expect(words(doc, 'SSO')).toEqual(['SSO', 'sso']);
  });

  it('takes the query literally', () => {
    expect(words(docOf('Costs $5 (or more).'), '$5 (or')).toEqual(['$5 (or']);
  });

  it('never matches across blocks or for an empty query', () => {
    expect(findMatches(doc, 'page.\nsso')).toEqual([]);
    expect(findMatches(doc, '')).toEqual([]);
  });
});
