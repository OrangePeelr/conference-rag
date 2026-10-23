const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseQuery, sourceContext } = require('../hybrid.js');

const speakers = ['By President Russell\u00a0M. Nelson', 'By Brother Michael T. Nelson',
    'By Elder Denelson Silva', 'By President Dallin H. Oaks'];

test('Nelson question becomes an author/date restriction with topic text left for retrieval', () => {
    const result = parseQuery('What did President Nelson teach about temples in 2024?', speakers);
    assert.equal(result.filters.author, 'President Nelson');
    assert.equal(result.filters.year_from, 2024);
    assert.equal(result.filters.year_to, 2024);
    assert.match(result.query, /temples/);
    assert.doesNotMatch(result.query, /Nelson|2024/i);
});
test('last-name-only author request preserves ambiguity and does not choose a first name', () => {
    assert.equal(parseQuery('talks by Nelson about peace', speakers).filters.author, 'Nelson');
    assert.equal(parseQuery('Nelson temple 2024', speakers).filters.author, 'Nelson');
});
test('questions about who quoted someone do not become an author restriction', () => {
    const result = parseQuery('Who quoted President Nelson about joy?', speakers);
    assert.equal(result.filters.author, undefined);
    assert.match(result.query, /President Nelson/);
});
test('full names and middle initials match stored Unicode whitespace', () => {
    assert.equal(parseQuery('Russell M. Nelson on hope', speakers).filters.author.trim().replace(/\s+/g, ' '), 'Russell M Nelson');
    assert.equal(parseQuery('Dallin Oaks on service', speakers).filters.author, 'Dallin Oaks');
});
test('quoted metadata operators preserve multiword names and titles', () => {
    const result = parseQuery('author:"President Nelson" title:"Think Celestial" year:2023 season:October hope', speakers);
    assert.deepEqual(result.filters, {author:'President Nelson',title:'Think Celestial',year_from:2023,year_to:2023,season:'October'});
    assert.equal(result.query, 'hope');
});
test('ranges and conference seasons are recognized', () => {
    const result = parseQuery('temples from 2022 through 2024 October', speakers);
    assert.equal(result.filters.year_from, 2022);
    assert.equal(result.filters.year_to, 2024);
    assert.equal(result.filters.season, 'October');
});
test('bad filters fail instead of silently widening the search', () => {
    for (const query of ['year:2024-2022', 'year:lastyear', 'season:May', 'author:', 'author:"Russell Nelson', 'year:2023 year:2024']) {
        assert.throws(() => parseQuery(query, speakers), undefined, query);
    }
});
test('source budget retains dates, caps total context, and avoids mutating source text', () => {
    const original = Array.from({length:8}, () => ({title:'Talk',speaker:'Author',year:2024,season:'April',text:'a'.repeat(40_000)}));
    const contexts = sourceContext(original);
    assert.ok(contexts.reduce((sum, talk) => sum + talk.text.length, 0) <= 125_000);
    assert.ok(contexts.every(talk => talk.text.length <= 30_000 && talk.year === 2024));
    assert.equal(original[0].text.length, 40_000);
});
