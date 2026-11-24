// api/vision.js — 약 사진 분석 + e약은요 검색 + 추측글 (Vercel 서버리스 함수)
const CLAUDE_URL = "https://api.anthropic.com/v1/messages";
const DRUG_URL = "http://apis.data.go.kr/1471000/DrbEasyDrugInfoService/getDrbEasyDrugList";
const MODEL = "claude-haiku-5-5";

// 1단계: 사진 읽기용 지시문 (짧게 쓰도록 제한)
const VISION_PROMPT =
  "너는 의약품 사진을 읽는 도우미야. 사진에 보이는 글자와 특징만 근거로 " +
  "아래 JSON 한 개만 출력해. 코드블록(```)이나 설명 문장은 절대 쓰지 마.\n" +
  '{"is_medicine": true 또는 false, ' +
  '"product_name": "포장에 인쇄된 제품명, 없으면 빈 문자열", ' +
  '"search_keywords": ["제품명 검색용 짧은 브랜드명, 최대 2개, 없으면 빈 배열"], ' +
  '"visible_text": "읽은 글자, 50자 이내", ' +
  '"description": "색·모양·형태 특징, 80자 이내 한 문장"}\n' +
  "알약에 새겨진 숫자나 각인(예: 100 MG)은 제품명이 아니니 product_name에 넣지 마.";

// 3단계: 추측글용 지시문
const GUESS_PROMPT =
  "너는 고등학생 학습용 의약품 데이터 도우미야. [사진 분석]과 [e약은요 검색 결과]를 비교해서 " +
  "사진 속 약이 어떤 제품일 가능성이 있는지 3~4문장으로 추측해. " +
  "'~로 보입니다', '~일 가능성이 있습니다' 같은 추측 표현을 쓰고, " +
  "검색 결과가 없으면 사진만으로는 제품을 특정하기 어렵다고 말하고 보이는 특징만 설명해. " +
  "복용 권유, 복용량, 진단 같은 의학적 조언은 절대 하지 마. " +
  "마지막에 '사진만으로는 정확한 확인이 어려우니 실제 복용 판단은 약사와 상담하세요.'를 붙여.";

// Claude에게 요청하고 글(text)만 돌려받기
async function askClaude(system, content, maxTokens) {
  const response = await fetch(CLAUDE_URL, {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system: system,
      messages: [{ role: "user", content: content }],
    }),
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error("AI 요청 실패: " + (result.error?.message || response.status));
  }
  return (result.content || [])
    .filter(block => block.type === "text")
    .map(block => block.text)
    .join("\n")
    .trim();
}

// AI 답변에서 JSON 꺼내기 (실패해도 멈추지 않음)
function parseAnalysis(text) {
  const cleaned = text.replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch (e) { /* 아래 기본값으로 */ }
  }
  // JSON이 중간에 잘렸으면 읽을 수 있는 항목만 골라내기
  const pick = field => {
    const m = cleaned.match(new RegExp('"' + field + '"\\s*:\\s*"([^"]*)'));
    return m ? m[1] : "";
  };
  return {
    is_medicine: true,
    product_name: pick("product_name"),
    search_keywords: [],
    visible_text: pick("visible_text"),
    description: pick("description") || "사진 분석 결과 일부만 읽었어요.",
  };
}

// HTML 태그·공백 정리
function clean(text) {
  if (!text) return "";
  return String(text).replace(/<[^>]+>/g, "").split(/\s+/).join(" ").trim();
}

// e약은요에서 제품명으로 검색
async function searchDrugs(keyword) {
  const params = new URLSearchParams({
    serviceKey: process.env.DATA_KEY,
    type: "json",
    pageNo: "1",
    numOfRows: "5",
    itemName: keyword,
  });
  const response = await fetch(`${DRUG_URL}?${params}`);
  const raw = await response.text();

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("e약은요 응답 오류: " + raw.slice(0, 150));
  }
  if (data.OpenAPI_ServiceResponse) {
    throw new Error("e약은요 키 오류: " + JSON.stringify(data.OpenAPI_ServiceResponse).slice(0, 150));
  }

  const items = data.body?.items || [];
  return items.map(item => ({
    id: item.itemSeq,
    name: item.itemName,
    company: item.entpName,
    effect: clean(item.efcyQesitm),
    use: clean(item.useMethodQesitm),
    caution: clean(item.atpnQesitm),
    side: clean(item.seQesitm),
    image: (item.itemImage || "").replace("http://", "https://"),
  }));
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST 요청만 받아요." });
  }
  if (!process.env.ANTHROPIC_API_KEY || !process.env.DATA_KEY) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY 또는 DATA_KEY 환경 변수가 없어요. 설정 후 Redeploy 하세요." });
  }

  const { image, mediaType } = req.body || {};
  if (!image) {
    return res.status(400).json({ error: "사진이 없어요." });
  }
  if (image.length > 4000000) {
    return res.status(413).json({ error: "사진이 너무 커요. 더 작은 사진으로 올려주세요." });
  }
  const allowed = ["image/jpeg", "image/png", "image/webp", "image/gif"];
  const type = allowed.includes(mediaType) ? mediaType : "image/jpeg";

  try {
    // ---------- 1단계: 사진 분석 ----------
    const analysisText = await askClaude(
      VISION_PROMPT,
      [
        { type: "image", source: { type: "base64", media_type: type, data: image } },
        { type: "text", text: "이 사진을 분석해서 JSON 한 개만 출력해." },
      ],
      1500
    );
    const analysis = parseAnalysis(analysisText);

    if (analysis.is_medicine === false) {
      return res.status(200).json({
        analysis,
        drugs: [],
        guess: "사진에서 의약품을 찾지 못했어요. 약 상자나 포장의 제품명이 잘 보이게 다시 찍어보세요.",
      });
    }

    // ---------- 2단계: e약은요 검색 (제품명이 있을 때만) ----------
    const keywords = [analysis.product_name, ...(analysis.search_keywords || [])]
      .filter(k => k && String(k).trim())
      .slice(0, 3);

    const found = new Map();   // 같은 약 중복 제거
    for (const keyword of keywords) {
      const list = await searchDrugs(keyword);
      list.forEach(d => { if (!found.has(d.id)) found.set(d.id, d); });
      if (found.size >= 5) break;
    }
    const drugs = [...found.values()].slice(0, 5);

    // ---------- 3단계: 추측글 ----------
    const guess = await askClaude(
      GUESS_PROMPT,
      "[사진 분석]\n" + JSON.stringify(analysis) +
      "\n\n[e약은요 검색 결과]\n" +
      (drugs.length
        ? JSON.stringify(drugs.map(d => ({ name: d.name, company: d.company, effect: d.effect.slice(0, 150) })))
        : "검색 결과 없음 (사진에서 제품명을 읽지 못함)"),
      1000
    );

    return res.status(200).json({ analysis, drugs, guess });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
