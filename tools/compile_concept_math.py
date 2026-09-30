#!/usr/bin/env python3
"""Compile additional-concept inline LaTeX to a portable, safe MathML AST.

Usage:
  PYTHONPATH=../tmua-math-typeset/python-lib python3 tools/compile_concept_math.py assets/studied-concepts.json
  Add --check to verify generated metadata without writing the catalogue.
Only additionalConcepts (or a review fragment's concepts) receive math metadata.
"""
import argparse
import json
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path
from latex2mathml.converter import convert

TAGS = set('math mrow mi mn mo mtext mspace msup msub msubsup mfrac msqrt mroot mfenced mover munder munderover mtable mtr mtd menclose mstyle mpadded mphantom mmultiscripts mprescripts none'.split())
ATTRS = set('display mathvariant stretchy symmetric fence separator accent accentunder form columnalign rowalign columnspacing rowspacing rowlines columnlines frame notation linethickness rowspan columnspan lspace rspace width height depth voffset scriptlevel displaystyle movablelimits largeop maxsize minsize'.split())
INLINE = re.compile(r'\\\(([\s\S]*?)\\\)')


def ast(element):
    tag = element.tag.rsplit('}', 1)[-1]
    if tag not in TAGS:
        raise ValueError(f'Unsupported MathML element: {tag}')
    attributes = dict(element.attrib)
    if any(name not in ATTRS for name in attributes):
        raise ValueError(f'Unsupported MathML attributes: {attributes}')
    children = []
    if element.text:
        children.append(element.text)
    for child in element:
        children.append(ast(child))
        if child.tail:
            children.append(child.tail)
    if any(isinstance(child, str) and re.search(r'\\[A-Za-z]+', child) for child in children):
        raise ValueError('A LaTeX command was not converted')
    node = {'tag': tag}
    if attributes:
        node['attrs'] = attributes
    if children:
        node['children'] = children
    return node


def texts(concept):
    yield from concept.get('knowledge', [])
    example = concept.get('example')
    if example:
        yield example['question']
        yield from example['steps']
        yield example['answer']
    if concept.get('pitfall'):
        yield concept['pitfall']


def compile_catalogue(catalogue):
    concepts = catalogue.get('additionalConcepts', catalogue.get('concepts'))
    if not isinstance(concepts, list):
        raise ValueError('Expected additionalConcepts or concepts array')
    count = 0
    for concept in concepts:
        expressions = {}
        for text in texts(concept):
            if text.count(r'\(') != text.count(r'\)'):
                raise ValueError(f'{concept["id"]}: unmatched inline math delimiters')
            for match in INLINE.finditer(text):
                latex = match.group(1)
                if not latex.strip():
                    raise ValueError(f'{concept["id"]}: empty formula')
                if latex not in expressions:
                    try:
                        expressions[latex] = ast(ET.fromstring(convert(latex)))
                    except Exception as error:
                        raise ValueError(f'{concept["id"]}: could not compile {latex!r}: {error}') from error
        concept['math'] = {'version': 1, 'expressions': expressions}
        count += len(expressions)
    return len(concepts), count


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('catalogue', type=Path)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    data = json.loads(args.catalogue.read_text())
    original = json.dumps(data, ensure_ascii=False, sort_keys=True)
    concepts, count = compile_catalogue(data)
    if args.check:
        if original != json.dumps(data, ensure_ascii=False, sort_keys=True):
            print('Concept math metadata is missing or stale. Re-run without --check.', file=sys.stderr)
            return 1
    else:
        (args.output or args.catalogue).write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
    print(f'{"Verified" if args.check else "Compiled"} {count} inline formulas across {concepts} additional concepts.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
