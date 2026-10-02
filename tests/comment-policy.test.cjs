const { test } = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../src/comment-policy.js');

const templates = [
  '맞아. 요즘같은 AI시대에서 커뮤니티 실명제는 꽤나 합리적인 제도일 수 있어.',
  '목소리 복제 진짜 정교해져서 찝찝하긴 하네',
  '목소리 복제 기술 진짜 무섭게 발전하긴 했네',
  '도구 제대로 갖춰서 자동화 돌리면 이런 노가다 좀 줄어들 텐데.'
];
const obvious = '정말 흥미로운 주제네요! 다양한 관점을 고려하여 균형 잡힌 시각으로 접근하는 것이 좋겠습니다. 여러분의 생각과 경험을 댓글로 공유해 주세요. 추가 질문이 있다면 언제든 말씀해 주세요.';

test('user-provided examples match only when templates are configured', () => {
  for (const text of templates) {
    assert.equal(policy.analyze(text).hide, false, text);
    const result = policy.analyze(text, { templates });
    assert.equal(result.hide, true, text);
    assert.match(result.reasons.join(' '), /등록한 봇 댓글 예시/);
  }
});

test('whole-sentence template matching tolerates spacing, punctuation and limited style changes', () => {
  for (const text of [
    '목소리복제 진짜 정교해져서 찝찝하긴 하네!!',
    '목소리 복제 정말 정교해져서 찜찜하긴 하네요.',
    '목소리 복제 기술 정말 무섭게 발전하긴 했네요',
    '도구 제대로 갖춰서 자동화 돌리면 이런 노가다 좀 줄어들 텐데요!',
    '맞아! 요즘같은 ＡＩ시대에서 커뮤니티 실명제는 꽤나 합리적인 제도일 수 있어'
  ]) assert.equal(policy.analyze(text, { templates }).hide, true, text);
});

test('same-topic statements, negation and substantive changed details are preserved', () => {
  for (const text of [
    '목소리 복제 기술은 전혀 정교하지 않아서 안 찝찝하네',
    '목소리 복제 진짜 정교해져서 안 찝찝하긴 하네',
    '목소리 복제 기술 진짜 무섭게 발전하진 않았네',
    '맞아. 요즘같은 AI시대에서 커뮤니티 실명제는 꽤나 합리적인 제도일 수 없어.',
    '도구 제대로 갖춰서 자동화 돌리면 이런 노가다 좀 늘어날 텐데.',
    '도구 제대로 갖춰서 자동화 돌리면 이런 노가다 좀 줄어들 텐데. 근데 장비가 80만원이라 수작업이 나음.',
    '목소리 복제 돌려보니까 한국어 받침이 계속 깨지더라. 48kHz 원본을 24kHz로 변환하니까 좀 나아짐.',
    '저 봇들이 목소리 복제 얘기만 하는 것 같아',
    'AI시대라 실명제 논의는 가능하지만 개인정보 유출 문제부터 해결해야 해.'
  ]) assert.equal(policy.analyze(text, { templates, sensitivity: 'strict' }).hide, false, text);
});

test('quoted examples and discussion of bot output are not treated as the actual example', () => {
  for (const text of [
    `“${templates[1]}”`,
    `"${templates[2]}" 이거 계속 올라오는데 봇 아님?`,
    `예시: ${templates[3]}`,
    `${templates[1]} 라는 댓글이 여러 번 보이더라.`,
    `> ${templates[1]}\n이게 왜 봇이라고 생각함?`,
    `챗GPT가 이렇게 답변하더라. ${obvious}`,
    `ChatGPT said: ${obvious}`,
    `\`\`\`text\n${obvious}\n\`\`\``
  ]) assert.equal(policy.analyze(text, { templates }).hide, false, text);
});

test('multiple assistant boilerplate signals are required for generic blocking', () => {
  assert.equal(policy.analyze(obvious).hide, true);
  assert.equal(policy.analyze('저는 AI 언어 모델로서 개인적인 감정이나 경험을 가지고 있지 않습니다. 추가 질문이 있다면 언제든 말씀해 주세요.').hide, true);
  assert.equal(policy.analyze('As an AI language model, I do not have personal feelings or experiences. Feel free to ask if you have any additional questions.').hide, true);
  assert.equal(policy.analyze('This is an interesting topic. A balanced perspective is helpful here. What do you all think? I hope this helps.').hide, true);
  assert.equal(policy.analyze('<|im_start|>assistant 저는 사용자에게 답변을 드리겠습니다. 이 문장은 출력 토큰이 들어 있는 답변입니다. <|im_end|>').hide, true);
});

test('politeness, AI discussion, markdown, ordinary advice and short comments stay visible', () => {
  for (const text of [
    '좋은 정보 감사합니다.', '좋은 글이네요. 잘 봤습니다. 감사합니다!',
    'As an AI researcher I use Python and run inference locally. My results are in the attached benchmark.',
    'As an AI researcher, I recommend running the benchmark with Python 3.12. Feel free to ask about the GPU settings.',
    '저는 AI 연구원입니다. 결과를 보니 GPU 드라이버 버전부터 확인해야 합니다. 추가 질문이 있다면 언제든 말씀해 주세요.',
    '저는 AI 모델을 직접 돌려 봤는데 VRAM 8GB에서 7B 양자화 모델도 버벅입니다. 질문이 있다면 아래 로그부터 확인해 주세요.',
    '좋은 정보 감사합니다. 어제 알려주신 방법으로 드라이버를 다시 설치했더니 화면 깜빡임이 사라졌습니다. 다른 분들도 설치 파일 버전부터 확인해 보세요.',
    '정리하자면 재설치 전에 먼저 아래 순서로 확인하세요.\n1. 케이블을 뽑고 다시 연결하세요.\n2. 장치 관리자에서 느낌표가 있는지 확인하세요. 문제가 계속되면 로그를 올려 주세요.',
    '다양한 관점을 고려할 수 있겠지만 나는 이 기능이 필요 없다고 생각함. 최근 업데이트 때문에 메모리 400MB 더 쓰던데 이건 고쳐야지.',
    '좋은 글입니다. 여러분은 이 사건을 어떻게 생각하시나요? 저는 보도 내용 중 날짜가 잘못된 것 같아서 원문을 찾아보겠습니다.',
    '좋은 글이고 도움이 많이 됐어요. 다음 글도 기대하겠습니다. 오늘도 좋은 하루 보내시고 건강 잘 챙기세요.',
    'Great post. I followed your steps and fixed the error on version 3.2. My config used the wrong port, so I changed it to 4000. Thanks!'
  ]) assert.equal(policy.analyze(text, { sensitivity: 'strict', templates }).hide, false, text);
});

test('strict means stronger filtering while unknown settings retain balanced behavior', () => {
  const borderline = '정말 흥미로운 주제네요! 다양한 관점을 고려해서 접근하면 좋겠습니다. 여러분의 생각과 경험을 댓글로 공유해 주세요.';
  assert.equal(policy.analyze(borderline).score, 6);
  assert.equal(policy.analyze(borderline).hide, false);
  assert.equal(policy.analyze(borderline, { sensitivity: 'strict' }).hide, true);
  assert.equal(policy.analyze(borderline, { sensitivity: 'unknown' }).hide, false);
});

test('repeated long boilerplate requires several distinct known authors', () => {
  const text = '좋은 정보 감사합니다. 게시물의 내용을 잘 읽어보았고 다음에도 유익한 자료를 올려주시면 참고하여 알아보도록 하겠습니다. 많은 분들에게 유익하리라 생각합니다.';
  const rows = ['author-a', 'author-b', 'author-c'].map((authorKey, id) => ({ id, text, authorKey }));
  assert.deepEqual(policy.analyzeComments(rows).map(row => row.blocked), [true, true, true]);
  assert.deepEqual(policy.analyzeComments(rows.map(row => ({ ...row, authorKey: 'one-author' }))).map(row => row.blocked), [false, false, false]);
  assert.deepEqual(policy.analyzeComments(rows.map(row => ({ ...row, authorKey: '' }))).map(row => row.blocked), [false, false, false]);
  assert.deepEqual(policy.analyzeComments(rows.slice(0, 2)).map(row => row.blocked), [false, false]);
  assert.deepEqual(policy.analyzeComments(rows.slice(0, 2), { sensitivity: 'strict' }).map(row => row.blocked), [true, true]);
});

test('repetition of plain technical content and short greetings does not imply bot activity', () => {
  for (const text of ['좋은 정보 감사합니다.', '오늘 서버가 20시부터 21시까지 점검 중이라서 로그인이 안 됩니다. 공지에는 작업이 끝나면 접속할 수 있다고 적혀 있고 데이터는 그대로 유지된다고 합니다.']) {
    const rows = ['a', 'b', 'c', 'd'].map((authorKey, id) => ({ id, text, authorKey }));
    assert.ok(policy.analyzeComments(rows, { sensitivity: 'strict' }).every(row => !row.blocked));
  }
});

test('batch results preserve IDs and reuse the same deterministic policy', () => {
  const rows = [{ id: 'c1', text: templates[0], authorKey: 'a' }, { id: 'c2', text: 'ㅋㅋㅋㅋ', authorKey: 'b' }];
  assert.deepEqual(policy.analyzeComments(rows, { templates }).map(({ id, blocked }) => ({ id, blocked })), [{ id: 'c1', blocked: true }, { id: 'c2', blocked: false }]);
  assert.deepEqual(policy.analyzeComments(null), []);
  assert.equal(globalThis.DCFBotPolicy, policy);
});

test('normalization safely handles Unicode, zero width, whitespace, length and invalid input', () => {
  assert.equal(policy.normalizeText('  ＡＩ\u200B 시대\n\t댓글  '), 'ai 시대 댓글');
  assert.equal(policy.analyze(null).hide, false);
  assert.equal(policy.analyze(42, null).hide, false);
  assert.equal(policy.analyze(obvious, null).hide, true);
  assert.equal(policy.analyze('x'.repeat(20000)).normalized.length, policy.MAX_TEXT_LENGTH);
  const clipped = policy.normalizeText('x'.repeat(policy.MAX_TEXT_LENGTH - 1) + '😀');
  assert.equal(clipped.endsWith('\uD83D'), false);
  assert.equal(policy.analyze(templates[1].replace('정교', '정\u200B교'), { templates }).hide, true);
});
