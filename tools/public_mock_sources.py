"""Exact identity boundary for freely published JZ Mock A–E originals."""
import re

PROVIDER = 'jzmaths-mock'
SOURCE_ID = re.compile(r'JZ-MOCK-([A-E])-P([12])-Q(0[1-9]|1[0-9]|20)')
PAPER_ID = re.compile(r'jz-mock-([a-e])-p([12])')


def public_mock_marked(value):
    return isinstance(value, dict) and (
        value.get('provider') == PROVIDER
        or isinstance(value.get('sourceId'), str) and value['sourceId'].startswith('JZ-MOCK-')
        or isinstance(value.get('id'), str) and re.fullmatch(r'jz-mock-[^-]+-p[0-9]+', value['id']) is not None)


def attributed(value, letter):
    return (isinstance(value, str) and re.search(r'\bJZ(?:\s*Maths)?\b', value, re.I) is not None
            and re.search(r'\bMock[\s·–—-]+' + letter + r'\b', value, re.I) is not None)


def public_mock_url(letter, paper):
    return f'https://jzmaths.com/papers/jz_mocks/jz_mock_{letter.lower()}_p{paper}_question.pdf'


def is_public_mock_metadata(metadata):
    if not isinstance(metadata, dict):
        return False
    match = PAPER_ID.fullmatch(metadata.get('id', '')) if isinstance(metadata.get('id'), str) else None
    return bool(match and metadata.get('provider') == PROVIDER
                and metadata.get('visibility') == 'public'
                and type(metadata.get('paper')) is int and metadata['paper'] == int(match[2])
                and metadata.get('pairId') == f'jz-{match[1]}'
                and metadata.get('sourceUrl') == public_mock_url(match[1], match[2])
                and attributed(metadata.get('source'), match[1])
                and metadata.get('practicePolicy') == 'after-miss-up-to-3'
                and type(metadata.get('questionCount')) is int and metadata['questionCount'] == 20)


def is_public_mock_original(exercise, metadata):
    if not isinstance(exercise, dict) or not is_public_mock_metadata(metadata):
        return False
    match = SOURCE_ID.fullmatch(exercise.get('sourceId', '')) if isinstance(exercise.get('sourceId'), str) else None
    return bool(match and exercise.get('provider') == PROVIDER
                and metadata['id'] == f'jz-mock-{match[1].lower()}-p{match[2]}'
                and exercise.get('sourceUrl') == public_mock_url(match[1], match[2])
                and attributed(exercise.get('source'), match[1])
                and exercise.get('visibility', 'public') == 'public')
