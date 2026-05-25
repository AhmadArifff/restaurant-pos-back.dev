const axios = require('axios');

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_FALLBACK_MODEL = 'openrouter/free';
const DEFAULT_SESSION_LIMIT = 10000;
const TOKEN_USAGE_WARNING_THRESHOLD = 80;
const SESSION_TTL_HOURS = 24;
const MAX_HISTORY_MESSAGES = 14;
const MAX_CONTEXT_CHARS = 12000;

const MODEL_CATALOG = [
  {
    id: 'qwen/qwen3-next-80b-a3b-instruct:free',
    name: 'Qwen3 Next 80B A3B Instruct (free)',
    provider: 'qwen',
    contextLength: 262144,
    weeklyTokenPool: 860000000,
    defaultMaxCompletionTokens: 1100,
    chatCapable: true,
    recommended: false,
  },
  {
    id: 'google/gemma-4-26b-a4b-it:free',
    name: 'Gemma 4 26B A4B IT (free)',
    provider: 'google',
    contextLength: 262144,
    weeklyTokenPool: 4040000000,
    defaultMaxCompletionTokens: 1100,
    chatCapable: true,
    recommended: false,
  },
  {
    id: 'meta-llama/llama-3.3-70b-instruct:free',
    name: 'Llama 3.3 70B Instruct (free)',
    provider: 'meta-llama',
    contextLength: 131072,
    weeklyTokenPool: 744000000,
    defaultMaxCompletionTokens: 1000,
    chatCapable: true,
    recommended: false,
  },
  {
    id: 'nvidia/nemotron-nano-12b-v2-vl:free',
    name: 'Nemotron Nano 12B 2 VL (free)',
    provider: 'nvidia',
    contextLength: 128000,
    weeklyTokenPool: 7860000000,
    defaultMaxCompletionTokens: 900,
    chatCapable: true,
    recommended: false,
  },
  {
    id: 'liquid/lfm-2.5-1.2b-thinking:free',
    name: 'LFM2.5-1.2B-Thinking (free)',
    provider: 'liquid',
    contextLength: 32768,
    weeklyTokenPool: 988000000,
    defaultMaxCompletionTokens: 700,
    chatCapable: true,
    recommended: false,
  },
  {
    id: 'liquid/lfm-2.5-1.2b-instruct:free',
    name: 'LFM2.5-1.2B-Instruct (free)',
    provider: 'liquid',
    contextLength: 32768,
    weeklyTokenPool: 756000000,
    defaultMaxCompletionTokens: 700,
    chatCapable: true,
    recommended: false,
  },
  {
    id: 'meta-llama/llama-3.2-3b-instruct:free',
    name: 'Llama 3.2 3B Instruct (free)',
    provider: 'meta-llama',
    contextLength: 131072,
    weeklyTokenPool: 87300000,
    defaultMaxCompletionTokens: 700,
    chatCapable: true,
    recommended: false,
  },
  {
    id: 'nousresearch/hermes-3-llama-3.1-405b:free',
    name: 'Hermes 3 405B Instruct (free)',
    provider: 'nousresearch',
    contextLength: 131072,
    weeklyTokenPool: 86500000,
    defaultMaxCompletionTokens: 1000,
    chatCapable: true,
    recommended: false,
  },
  {
    id: 'qwen/qwen3-coder:free',
    name: 'Qwen3 Coder 480B A35B (free)',
    provider: 'qwen',
    contextLength: 1048576,
    weeklyTokenPool: null,
    defaultMaxCompletionTokens: 1000,
    chatCapable: true,
    recommended: false,
  },
  {
    id: 'cognitivecomputations/dolphin-mistral-24b-venice-edition:free',
    name: 'Venice Uncensored (free)',
    provider: 'venice',
    contextLength: 32768,
    weeklyTokenPool: 172000000,
    defaultMaxCompletionTokens: 900,
    chatCapable: true,
    recommended: false,
  },
  {
    id: 'openrouter/free',
    name: 'OpenRouter Free Models Router',
    provider: 'openrouter',
    contextLength: 200000,
    weeklyTokenPool: null,
    defaultMaxCompletionTokens: 1000,
    chatCapable: true,
    recommended: true,
  },
];

const MODEL_MAP = new Map(MODEL_CATALOG.map((model) => [model.id, model]));

const sessionTokenStore = new Map();

function parseModelList(value) {
  return String(value || '')
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function uniqueModelIds(ids) {
  return [...new Set(ids.filter(Boolean))];
}

function buildDynamicModelConfig(modelId) {
  return {
    id: modelId,
    name: `${modelId} (custom env)`,
    provider: modelId.split('/')[0] || 'custom',
    contextLength: Number(process.env.OPENROUTER_DEFAULT_CONTEXT_LENGTH || 128000),
    weeklyTokenPool: null,
    defaultMaxCompletionTokens: Number(process.env.OPENROUTER_DEFAULT_MAX_TOKENS || 1000),
    chatCapable: true,
    recommended: false,
    custom: true,
  };
}

function getConfiguredModelIds() {
  const envModels = [
    ...parseModelList(process.env.OPENROUTER_MODEL),
    ...parseModelList(process.env.OPENROUTER_MODEL_FALLBACKS),
    ...parseModelList(process.env.OPENROUTER_FREE_MODELS),
  ];

  return uniqueModelIds([
    ...envModels,
    DEFAULT_FALLBACK_MODEL,
    ...MODEL_CATALOG.map((model) => model.id),
  ]);
}

function getSessionTokenTracker(sessionId) {
  if (!sessionTokenStore.has(sessionId)) {
    sessionTokenStore.set(sessionId, {
      createdAt: new Date(),
      lastActivity: new Date(),
      usageByModel: {},
    });
  }

  const tracker = sessionTokenStore.get(sessionId);
  tracker.lastActivity = new Date();

  const nowMs = Date.now();
  for (const [key, value] of sessionTokenStore.entries()) {
    const ageInHours = (nowMs - value.createdAt.getTime()) / (1000 * 60 * 60);
    if (ageInHours > SESSION_TTL_HOURS) {
      sessionTokenStore.delete(key);
    }
  }

  return tracker;
}

function getModelConfig(requestedModelId) {
  if (requestedModelId && MODEL_MAP.has(requestedModelId)) {
    return MODEL_MAP.get(requestedModelId);
  }

  if (requestedModelId) {
    return buildDynamicModelConfig(requestedModelId);
  }

  const preferredModelId = getConfiguredModelIds()[0] || DEFAULT_FALLBACK_MODEL;
  if (MODEL_MAP.has(preferredModelId)) {
    return MODEL_MAP.get(preferredModelId);
  }

  return buildDynamicModelConfig(preferredModelId);
}

function calculateTokenUsageStatus(tokensUsed, tokenLimit, modelConfig) {
  const safeLimit = Number(tokenLimit) > 0 ? Number(tokenLimit) : DEFAULT_SESSION_LIMIT;
  const percentage = (tokensUsed / safeLimit) * 100;
  const tokensRemaining = Math.max(0, safeLimit - tokensUsed);

  return {
    model: modelConfig.id,
    modelName: modelConfig.name,
    modelContextLength: modelConfig.contextLength,
    tokensUsed,
    tokenLimit: safeLimit,
    percentageUsed: Math.min(100, Math.round(percentage * 100) / 100),
    isWarning: percentage >= TOKEN_USAGE_WARNING_THRESHOLD,
    isExceeded: false,
    tokensRemaining,
    limitType: 'context_window_estimate',
  };
}

function estimatePromptTokens(messages) {
  const chars = messages
    .map((m) => (typeof m.content === 'string' ? m.content.length : 0))
    .reduce((sum, n) => sum + n, 0);

  return Math.max(1, Math.ceil(chars / 4));
}

function getPerModelUsage(tracker, modelId) {
  return Number(tracker.usageByModel[modelId] || 0);
}

function increasePerModelUsage(tracker, modelId, amount) {
  const next = Math.max(0, Number(amount || 0));
  tracker.usageByModel[modelId] = next;
  return next;
}

function sanitizeConversationHistory(conversationHistory = []) {
  if (!Array.isArray(conversationHistory)) return [];

  return conversationHistory
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
    .map((m) => ({ role: m.role, content: String(m.content || '').slice(0, 2000) }))
    .slice(-MAX_HISTORY_MESSAGES);
}

function serializeContextPayload(payload) {
  const raw = JSON.stringify(payload, null, 2);
  return raw.length > MAX_CONTEXT_CHARS
    ? `${raw.slice(0, MAX_CONTEXT_CHARS)}\n... [dipotong karena terlalu panjang]`
    : raw;
}

function formatRupiah(value) {
  return `Rp ${Math.round(Number(value || 0)).toLocaleString('id-ID')}`;
}

function buildDirectBusinessResponse(userMessage, contextData, intentText = userMessage) {
  if (!contextData) return null;

  const lowerMessage = String(intentText || userMessage).toLowerCase();
  const lowerCurrentMessage = String(userMessage || '').toLowerCase();
  const isShortFollowUp = /^(iya|ya|boleh|lanjut|tolong|oke|ok|sip|gas|yuk)[\s!.?]*$/i.test(String(userMessage || '').trim());
  const directIntentText = isShortFollowUp ? lowerMessage : lowerCurrentMessage;
  const salesContext = contextData.find((ctx) => ctx.label.includes('penjualan'))?.value;
  const staffPerformance = contextData.find((ctx) => ctx.label.includes('Performa penjualan karyawan'))?.value;
  const stockOverview = contextData.find((ctx) => ctx.label.includes('stok bahan'))?.value;
  const stockMovements = contextData.find((ctx) => ctx.label.includes('stok masuk'))?.value;
  const stockRequests = contextData.find((ctx) => ctx.label.includes('Pengajuan stok kasir'))?.value;

  if (
    staffPerformance &&
    (
      directIntentText.includes('user') ||
      directIntentText.includes('karyawan') ||
      directIntentText.includes('kasir') ||
      directIntentText.includes('admin') ||
      directIntentText.includes('berdasarkan') ||
      directIntentText.includes('per produk') ||
      directIntentText.includes('produk tertentu') ||
      directIntentText.includes('margin') ||
      directIntentText.includes('keuntungan') ||
      directIntentText.includes('untung') ||
      directIntentText.includes('profit') ||
      directIntentText.includes('hpp') ||
      directIntentText.includes('modal') ||
      directIntentText.includes('biaya bahan') ||
      directIntentText.includes('biaya produksi')
    ) &&
    (
      directIntentText.includes('revenue') ||
      directIntentText.includes('revenu') ||
      directIntentText.includes('omzet') ||
      directIntentText.includes('penjualan') ||
      directIntentText.includes('transaksi') ||
      directIntentText.includes('produk') ||
      directIntentText.includes('margin') ||
      directIntentText.includes('keuntungan') ||
      directIntentText.includes('untung') ||
      directIntentText.includes('profit') ||
      directIntentText.includes('hpp') ||
      directIntentText.includes('modal') ||
      directIntentText.includes('biaya bahan') ||
      directIntentText.includes('biaya produksi')
    )
  ) {
    const users = staffPerformance.per_user || [];
    const totalOmzet = Number(staffPerformance.total_omzet || 0);
    const totalHpp = Number(staffPerformance.total_hpp || 0);
    const totalMargin = Number(staffPerformance.total_margin || 0);
    const totalTransactions = Number(staffPerformance.total_transaksi || 0);
    const asksHpp =
      directIntentText.includes('hpp') ||
      directIntentText.includes('modal') ||
      directIntentText.includes('biaya bahan') ||
      directIntentText.includes('biaya produksi');
    const showProductBreakdown =
      directIntentText.includes('produk') ||
      directIntentText.includes('product') ||
      directIntentText.includes('tertentu') ||
      directIntentText.includes('berdasarkan');
    const asksTopMargin =
      directIntentText.includes('paling besar') ||
      directIntentText.includes('terbesar') ||
      directIntentText.includes('tertinggi') ||
      directIntentText.includes('terbaik');
    const sortedUsers = asksTopMargin
      ? [...users].sort((a, b) => Number(b.margin || 0) - Number(a.margin || 0))
      : users;

    const userRows = sortedUsers.map((user) => asksHpp
      ? `| ${user.nama} | ${user.role} | ${user.transaksi} | ${formatRupiah(user.omzet)} | ${formatRupiah(user.hpp)} | ${formatRupiah(user.margin)} | ${user.margin_persen}% |`
      : `| ${user.nama} | ${user.role} | ${user.transaksi} | ${formatRupiah(user.omzet)} | ${formatRupiah(user.margin)} | ${user.margin_persen}% |`
    );

    const productRows = users.flatMap((user) =>
      (user.produk || []).map((product) => asksHpp
        ? `| ${user.nama} | ${product.produk} | ${product.qty} | ${formatRupiah(product.omzet)} | ${formatRupiah(product.hpp)} | ${formatRupiah(product.margin)} | ${product.margin_persen}% |`
        : `| ${user.nama} | ${product.produk} | ${product.qty} | ${formatRupiah(product.omzet)} | ${formatRupiah(product.margin)} | ${product.margin_persen}% |`
      )
    );

    return [
      `**Ringkasnya:**`,
      totalTransactions > 0 && asksTopMargin && sortedUsers[0]
        ? `Margin keuntungan paling besar pada periode ${staffPerformance.periode} adalah **${sortedUsers[0].nama}** dengan margin **${formatRupiah(sortedUsers[0].margin)}** dari omzet **${formatRupiah(sortedUsers[0].omzet)}**.`
        : totalTransactions > 0 && asksHpp
        ? `Pada periode ${staffPerformance.periode}, total HPP transaksi berdasarkan karyawan adalah **${formatRupiah(totalHpp)}** dari omzet **${formatRupiah(totalOmzet)}**, sehingga estimasi margin menjadi **${formatRupiah(totalMargin)}**.`
        : totalTransactions > 0
        ? `Pada periode ${staffPerformance.periode}, total omzet karyawan adalah **${formatRupiah(totalOmzet)}** dari **${totalTransactions} transaksi**, dengan estimasi margin **${formatRupiah(totalMargin)}**.`
        : `Pada periode ${staffPerformance.periode}, belum ada transaksi karyawan yang tercatat.`,
      '',
      `**Detail data:**`,
      asksHpp ? `| Karyawan | Role | Transaksi | Omzet | HPP | Margin | Margin % |` : `| Karyawan | Role | Transaksi | Omzet | Margin | Margin % |`,
      asksHpp ? `|---|---|---:|---:|---:|---:|---:|` : `|---|---|---:|---:|---:|---:|`,
      ...(userRows.length > 0
        ? userRows
        : [asksHpp ? '| Belum ada data | - | 0 | Rp 0 | Rp 0 | Rp 0 | 0% |' : '| Belum ada data | - | 0 | Rp 0 | Rp 0 | 0% |']),
      '',
      showProductBreakdown ? `Breakdown produk per karyawan:` : null,
      showProductBreakdown && productRows.length > 0
        ? [
            asksHpp ? `| Karyawan | Produk | Qty | Omzet | HPP | Margin | Margin % |` : `| Karyawan | Produk | Qty | Omzet | Margin | Margin % |`,
            asksHpp ? `|---|---|---:|---:|---:|---:|---:|` : `|---|---|---:|---:|---:|---:|`,
            ...productRows,
          ].join('\n')
        : null,
      showProductBreakdown && productRows.length === 0 ? `Belum ada detail produk pada periode ini.` : null,
      '',
      `**Saran berikutnya:**`,
      asksHpp ? `1. Gunakan HPP untuk melihat estimasi biaya bahan yang terpakai dari transaksi tiap karyawan.` : `1. Gunakan omzet untuk melihat kontribusi penjualan tiap karyawan.`,
      asksHpp ? `2. Bandingkan HPP dengan omzet agar terlihat margin yang benar-benar tersisa.` : `2. Gunakan margin untuk melihat keuntungan setelah estimasi biaya bahan produk.`,
      `3. Jika ingin lebih tajam, bandingkan performa per produk agar terlihat produk mana yang paling menguntungkan.`,
      '',
      asksHpp
        ? `**Lanjut cek apa?** Mau saya tampilkan HPP per produk atau ranking karyawan dengan HPP terbesar?`
        : `**Lanjut cek apa?** Mau saya urutkan karyawan dengan margin tertinggi atau tampilkan produk yang paling menguntungkan?`,
    ].filter((line) => line !== null).join('\n');
  }

  if (
    salesContext &&
    (lowerCurrentMessage.includes('hari ini') || lowerCurrentMessage.includes('today')) &&
    (lowerCurrentMessage.includes('revenue') || lowerCurrentMessage.includes('revenu') || lowerCurrentMessage.includes('omzet') || lowerCurrentMessage.includes('penjualan'))
  ) {
    const todayDate = salesContext['tanggal hari ini'];
    const todayRevenue = Number(salesContext['omzet hari ini'] || 0);
    const todayTransactions = Number(salesContext['transaksi hari ini'] || 0);
    const periodRevenue = Number(salesContext['total omzet periode'] || 0);
    const periodTransactions = Number(salesContext['jumlah transaksi periode'] || 0);

    return [
      `**Ringkasnya:**`,
      todayTransactions > 0
        ? `Revenue hari ini (${todayDate}) adalah **${formatRupiah(todayRevenue)}** dari **${todayTransactions} transaksi**.`
        : `Revenue hari ini (${todayDate}) masih **${formatRupiah(0)}** karena belum ada transaksi yang tercatat di aplikasi.`,
      '',
      `**Detail data:**`,
      `| Metrik | Nilai |`,
      `|---|---:|`,
      `| Omzet hari ini | ${formatRupiah(todayRevenue)} |`,
      `| Transaksi hari ini | ${todayTransactions} |`,
      `| Omzet 30 hari terakhir | ${formatRupiah(periodRevenue)} |`,
      `| Transaksi 30 hari terakhir | ${periodTransactions} |`,
      '',
      `**Saran berikutnya:**`,
      `1. Pastikan semua transaksi hari ini sudah dicatat di aplikasi POS.`,
      `2. Jika ingin evaluasi performa, bandingkan hari ini dengan kemarin atau 7 hari terakhir.`,
      `3. Cek produk terlaris agar promosi bisa diarahkan ke menu yang paling cepat bergerak.`,
      '',
      `**Lanjut cek apa?** Mau saya bandingkan revenue hari ini dengan 7 hari terakhir atau tampilkan produk paling laris?`,
    ].join('\n');
  }

  if (
    stockOverview &&
    directIntentText.includes('stok') &&
    !directIntentText.includes('margin') &&
    !directIntentText.includes('keuntungan') &&
    !directIntentText.includes('profit') &&
    (directIntentText.includes('sisa') || directIntentText.includes('tersisa') || directIntentText.includes('masuk'))
  ) {
    const items = stockOverview.stok_terbanyak || [];
    const emptyCount = Number(stockOverview.bahan_habis || 0);
    const attentionCount = Number(stockOverview.bahan_perlu_perhatian || 0);
    const incoming = stockMovements?.stok_masuk_terbaru || [];

    const rows = items.length > 0
      ? items.map((item) => {
          const status = item.sisa <= 0
            ? 'Habis'
            : item.sisa <= item.batas_minimum
              ? 'Perlu perhatian'
              : 'Aman';
          return `| ${item.bahan} | ${item.sisa} ${item.satuan} | ${item.batas_minimum} ${item.satuan} | ${status} |`;
        })
      : ['| Belum ada bahan tersedia | 0 | - | Belum tersedia |'];

    const incomingSummary = incoming.length > 0
      ? incoming
          .slice(0, 5)
          .map((item) => `- ${item.bahan}: ${item.jumlah} ${item.satuan}`)
          .join('\n')
      : '- Belum ada catatan stok masuk terbaru pada aktivitas yang ditampilkan.';

    return [
      `**Ringkasnya:**`,
      `Ya, masih ada stok tersisa. Saat ini **${stockOverview.bahan_masih_tersedia} dari ${stockOverview.total_bahan} bahan** masih tersedia, dengan estimasi nilai stok **${formatRupiah(stockOverview.estimasi_nilai_stok)}**.`,
      '',
      `**Detail data:**`,
      `| Bahan | Sisa saat ini | Batas minimum | Status |`,
      `|---|---:|---:|---|`,
      ...rows,
      '',
      `Aktivitas stok masuk terbaru:`,
      incomingSummary,
      '',
      `Catatan: ${emptyCount} bahan habis dan ${attentionCount} bahan perlu perhatian.`,
      '',
      `**Saran berikutnya:**`,
      `1. Pantau bahan yang mendekati batas minimum sebelum operasional ramai.`,
      `2. Prioritaskan restock untuk bahan dengan sisa paling kecil.`,
      `3. Cocokkan pemakaian bahan dengan menu terlaris agar pembelian stok lebih tepat.`,
      '',
      `**Lanjut cek apa?** Mau saya tampilkan bahan mana yang paling cepat berkurang atau estimasi kebutuhan restock berikutnya?`,
    ].join('\n');
  }

  if (
    stockRequests &&
    (directIntentText.includes('pengajuan') || directIntentText.includes('kasir') || directIntentText.includes('mengambil') || directIntentText.includes('diambil'))
  ) {
    const isPendingQuestion =
      directIntentText.includes('pending') ||
      directIntentText.includes('menunggu') ||
      directIntentText.includes('belum disetujui') ||
      directIntentText.includes('belum diproses');

    if (isPendingQuestion) {
      const pendingRequests = (stockRequests.pengajuan_terbaru || []).filter((item) => {
        const status = String(item.status || '').toLowerCase();
        return status === 'pending' || status === 'menunggu' || item.disetujui === null;
      });
      const rows = pendingRequests.map((item) =>
        `| ${item.kasir || 'Kasir'} | ${item.role || 'kasir'} | ${item.bahan} | ${item.diminta} ${item.satuan} | ${item.status || 'pending'} |`
      );

      return [
        `**Ringkasnya:**`,
        pendingRequests.length > 0
          ? `Ada **${pendingRequests.length} bahan** dari pengajuan stok kasir yang masih menunggu persetujuan.`
          : `Tidak ada pengajuan stok kasir yang masih pending/menunggu pada data terbaru.`,
        '',
        `**Detail data:**`,
        rows.length > 0
          ? [
              `| Kasir | Role | Bahan | Jumlah diajukan | Status |`,
              `|---|---|---|---:|---|`,
              ...rows,
            ].join('\n')
          : `Semua pengajuan stok kasir yang tampil di data terbaru sudah diproses, jadi belum ada bahan yang perlu disetujui dari daftar tersebut.`,
        '',
        `**Saran berikutnya:**`,
        `1. Jika kasir merasa ada pengajuan baru, minta mereka cek ulang periode tanggal yang dipakai di halaman stok.`,
        `2. Untuk pengajuan yang sudah disetujui, cocokkan jumlah bahan dengan stok kasir agar pemakaian tetap rapi.`,
        `3. Pantau bahan yang sering diajukan agar pembelian stok berikutnya lebih tepat.`,
        '',
        `**Lanjut cek apa?** Mau saya tampilkan pengajuan yang sudah disetujui atau ringkasan stok per bahan?`,
      ].join('\n');
    }

    const cashiers = stockRequests.kasir_dan_bahan || [];
    const rows = cashiers.flatMap((cashier) =>
      (cashier.bahan || []).map((item) =>
        `| ${cashier.kasir} | ${cashier.role} | ${item.bahan} | ${item.disetujui} ${item.satuan} | ${item.status} |`
      )
    );

    return [
      `**Ringkasnya:**`,
      cashiers.length > 0
        ? `Ada **${cashiers.length} kasir** yang memiliki pengajuan stok disetujui/diambil pada data terbaru.`
        : `Belum ada kasir yang memiliki pengajuan stok disetujui/diambil pada data terbaru.`,
      '',
      `**Detail data:**`,
      rows.length > 0
        ? [
            `| Kasir | Role | Bahan | Jumlah disetujui | Status |`,
            `|---|---|---|---:|---|`,
            ...rows,
          ].join('\n')
        : `Belum ada bahan dari pengajuan kasir yang tercatat sudah disetujui/diambil.`,
      '',
      `**Saran berikutnya:**`,
      `1. Cocokkan bahan yang sudah disetujui dengan pemakaian stok di kasir.`,
      `2. Pantau bahan yang paling sering diajukan agar pembelian stok lebih tepat.`,
      `3. Jika perlu, lihat pengajuan terbaru untuk membedakan yang pending dan yang sudah disetujui.`,
      '',
      `**Lanjut cek apa?** Mau saya tampilkan pengajuan yang masih pending atau bahan yang paling sering diajukan kasir?`,
    ].join('\n');
  }

  return null;
}

async function fetchContextData(userMessage) {
  const lowerMessage = userMessage.toLowerCase();
  const tasks = [];
  const addContextTask = (url, label) => {
    tasks.push(
      axios
        .get(url)
        .then((res) => (res.data?.success ? { label, value: res.data.data } : null))
        .catch(() => null)
    );
  };

  const needsSales =
    lowerMessage.includes('penjualan') ||
    lowerMessage.includes('revenue') ||
    lowerMessage.includes('revenu') ||
    lowerMessage.includes('sales') ||
    lowerMessage.includes('omzet') ||
    lowerMessage.includes('hari ini') ||
    lowerMessage.includes('bulan ini') ||
    lowerMessage.includes('tahun ini') ||
    lowerMessage.includes('margin') ||
    lowerMessage.includes('keuntungan') ||
    lowerMessage.includes('profit') ||
    lowerMessage.includes('laba') ||
    lowerMessage.includes('hpp') ||
    lowerMessage.includes('modal') ||
    lowerMessage.includes('untung');

  if (needsSales) {
    addContextTask('http://localhost:5000/api/ai/data?context=sales&days=30', 'Ringkasan penjualan 30 hari terakhir');
  }

  const needsStaffPerformance =
    (
      lowerMessage.includes('user') ||
      lowerMessage.includes('karyawan') ||
      lowerMessage.includes('kasir') ||
      lowerMessage.includes('admin') ||
      lowerMessage.includes('staff') ||
      lowerMessage.includes('siapa') ||
      lowerMessage.includes('paling besar') ||
      lowerMessage.includes('terbesar') ||
      lowerMessage.includes('tertinggi') ||
      lowerMessage.includes('berdasarkan') ||
      lowerMessage.includes('per user') ||
      lowerMessage.includes('per karyawan')
    ) &&
    (
      lowerMessage.includes('revenue') ||
      lowerMessage.includes('revenu') ||
      lowerMessage.includes('omzet') ||
      lowerMessage.includes('margin') ||
      lowerMessage.includes('transaksi') ||
      lowerMessage.includes('produk') ||
      lowerMessage.includes('penjualan')
    );

  if (needsStaffPerformance) {
    addContextTask('http://localhost:5000/api/ai/data?context=staff-performance', 'Performa penjualan karyawan bulan ini');
  }

  const needsStock =
    lowerMessage.includes('stok') ||
    lowerMessage.includes('stock') ||
    lowerMessage.includes('bahan') ||
    lowerMessage.includes('tersisa') ||
    lowerMessage.includes('sisa') ||
    lowerMessage.includes('masuk') ||
    lowerMessage.includes('keluar') ||
    lowerMessage.includes('rendah') ||
    lowerMessage.includes('pesan');

  if (needsStock) {
    addContextTask('http://localhost:5000/api/ai/data?context=stock-overview', 'Ringkasan stok bahan saat ini');
    addContextTask('http://localhost:5000/api/ai/data?context=low-stock', 'Bahan yang perlu perhatian');
    addContextTask('http://localhost:5000/api/ai/data?context=stock-movements&limit=20', 'Aktivitas stok masuk dan keluar terbaru');
  }

  if (
    lowerMessage.includes('pengajuan') ||
    lowerMessage.includes('kasir') ||
    lowerMessage.includes('mengambil') ||
    lowerMessage.includes('diambil') ||
    lowerMessage.includes('request stok')
  ) {
    addContextTask('http://localhost:5000/api/ai/data?context=stock-requests&limit=30', 'Pengajuan stok kasir terbaru');
  }

  if (
    lowerMessage.includes('terlaris') ||
    lowerMessage.includes('best selling') ||
    lowerMessage.includes('best-selling') ||
    lowerMessage.includes('populer') ||
    lowerMessage.includes('produk') ||
    lowerMessage.includes('menu') ||
    lowerMessage.includes('margin') ||
    lowerMessage.includes('profit')
  ) {
    addContextTask('http://localhost:5000/api/ai/data?context=best-selling&limit=10', 'Produk terlaris');
  }

  if (lowerMessage.includes('transaksi') || lowerMessage.includes('penjualan terakhir')) {
    addContextTask('http://localhost:5000/api/ai/data?context=transactions&limit=10', 'Transaksi terbaru');
  }

  if (lowerMessage.includes('absen') || lowerMessage.includes('kehadiran') || lowerMessage.includes('staff')) {
    addContextTask('http://localhost:5000/api/ai/data?context=attendance', 'Kehadiran tim hari ini');
  }

  if (tasks.length === 0) return null;

  const results = await Promise.all(tasks);
  const valid = results.filter(Boolean);
  if (valid.length === 0) return null;

  return valid;
}

function buildSystemPrompt() {
  const today = new Date().toISOString().slice(0, 10);

  return `Anda adalah AI Assistant profesional untuk aplikasi Kebab POS.

Tanggal hari ini: ${today}

Kepribadian dan peran:
- Profesional, friendly, informatif, dan mudah dipahami pemilik/kasir/admin restoran.
- Fokus pada data aplikasi ini: penjualan, transaksi, stok, produk, profit/HPP jika tersedia, absensi, dan performa operasional.
- Jangan terdengar seperti teknisi. Hindari istilah teknis seperti database, endpoint, API, integrasi, query, kolom, field, table, raw data, JSON, atau nama struktur internal.
- Jika pertanyaan user di luar aplikasi Kebab POS atau tidak berkaitan dengan data operasional restoran, jawab profesional dan singkat bahwa AI Assistant ini difokuskan untuk membantu data aplikasi. Arahkan kembali ke topik yang bisa dibantu: omzet, margin, transaksi, produk, stok, pengajuan kasir, laporan, tim kasir, pengaturan, atau landing page.

Cara menjawab:
- Jawab pertanyaan user secara langsung lebih dulu.
- Olah data menjadi insight, bukan menyalin label data mentah.
- Gunakan angka, rupiah, tanggal, jumlah bahan/produk/transaksi jika tersedia.
- Jika cocok, tampilkan data dalam tabel markdown sederhana dengan judul kolom yang ramah user, misalnya "Tanggal", "Omzet", "Transaksi", "Bahan", "Sisa", "Status".
- Jangan tampilkan nama kolom internal seperti total_sales, daily_breakdown, stock, min_stock, created_at, atau label konteks.
- Jangan menyuruh user menghubungi tim IT, membahas koneksi, database, atau integrasi. Jika data belum tersedia, katakan secara operasional: "belum ada catatan transaksi/stok untuk periode ini" dan sarankan cek pencatatan di aplikasi.
- Untuk pertanyaan stok, bedakan:
  a) stok masuk = aktivitas penambahan stok,
  b) stok keluar = aktivitas pemakaian/pengurangan stok,
  c) stok tersisa = saldo stok saat ini.
- Jika user bertanya "stok yang masuk apakah ada yang tersisa", jawab saldo stok tersisa saat ini terlebih dahulu, lalu jelaskan aktivitas stok masuk/keluar terbaru.
- Jangan menyimpulkan stok habis hanya karena daftar bahan perlu perhatian kosong.
- Jangan mengarang data. Jika data tidak tersedia, sebutkan dengan jujur dan jelaskan batasannya secara sederhana.
- Jika user bertanya "hari ini", gunakan angka khusus hari ini. Jangan memakai total 7/30 hari terakhir sebagai pengganti angka hari ini.
- Untuk pertanyaan yang bukan tentang aplikasi, jangan menjawab topik umum tersebut secara panjang. Tetap ramah, beri batasan, lalu tawarkan pertanyaan lanjutan yang terkait data aplikasi.

Format wajib setiap jawaban:
1. "Ringkasnya:" 1-2 kalimat yang langsung menjawab.
2. "Detail data:" berisi poin atau tabel jika membantu.
3. "Saran berikutnya:" 1-3 langkah operasional yang realistis.
4. "Lanjut cek apa?" berisi satu pertanyaan lanjutan yang mendorong eksplorasi data aplikasi, misalnya minta periode, produk, cabang/kasir, atau perbandingan.

Gaya bahasa:
- Bahasa Indonesia natural.
- Padat, hangat, dan tidak kaku.
- Untuk jawaban sederhana, cukup 120-180 kata. Untuk analisis data yang perlu tabel, boleh lebih panjang tetapi tetap rapi.`;
}

function computeModelTokenLimit(modelConfig) {
  return modelConfig.contextLength || DEFAULT_SESSION_LIMIT;
}

function buildModelStatus(modelConfig, sessionTracker) {
  const tokenLimit = computeModelTokenLimit(modelConfig);
  return calculateTokenUsageStatus(0, tokenLimit, modelConfig);
}

function resolveMaxCompletionTokens({ requestedMaxTokens, modelConfig, tokenStatus, messages }) {
  const promptEstimate = estimatePromptTokens(messages);
  const contextLimit = modelConfig.contextLength || tokenStatus.tokenLimit || DEFAULT_SESSION_LIMIT;
  const remainingBudget = Math.max(0, contextLimit - promptEstimate);

  const byRequest = Number.isFinite(Number(requestedMaxTokens))
    ? Math.max(64, Number(requestedMaxTokens))
    : modelConfig.defaultMaxCompletionTokens || 900;

  const hardModelCap = modelConfig.defaultMaxCompletionTokens || 1200;

  if (remainingBudget <= 0) {
    return 0;
  }

  return Math.max(64, Math.min(byRequest, hardModelCap, remainingBudget));
}

function getAvailableChatModels() {
  return getConfiguredModelIds().map((modelId, index) => {
    const model = getModelConfig(modelId);
    return {
    id: model.id,
    name: model.name,
    provider: model.provider,
    contextLength: model.contextLength,
    weeklyTokenPool: model.weeklyTokenPool,
    chatCapable: model.chatCapable,
    recommended: index === 0 || model.recommended,
    disabledReason: model.disabledReason || null,
      custom: Boolean(model.custom),
    };
  });
}

function getFallbackModelId(currentModelId, attemptedModelIds = []) {
  const attempted = new Set([...attemptedModelIds, currentModelId].filter(Boolean));
  return getConfiguredModelIds().find((modelId) => !attempted.has(modelId)) || null;
}

function shouldFallbackFromProviderError(axiosError) {
  const status = axiosError.response?.status;
  if ([402, 408, 409, 429, 500, 502, 503, 504].includes(status)) return true;

  const providerMessage = String(
    axiosError.response?.data?.error?.message ||
    axiosError.response?.data?.message ||
    axiosError.response?.data?.error ||
    axiosError.message ||
    ''
  ).toLowerCase();

  return (
    providerMessage.includes('rate limit') ||
    providerMessage.includes('quota') ||
    providerMessage.includes('insufficient') ||
    providerMessage.includes('no endpoints') ||
    providerMessage.includes('overloaded') ||
    providerMessage.includes('provider')
  );
}

async function sendAIQuery(
  userMessage,
  conversationHistory = [],
  sessionId = 'default',
  options = {}
) {
  try {
    const selectedModel = getModelConfig(options.modelId);
    const attemptedModelIds = Array.isArray(options.attemptedModelIds) ? options.attemptedModelIds : [];

    if (!selectedModel.chatCapable) {
      return {
        success: false,
        response: null,
        error: 'Model yang dipilih bukan model chat',
        message: `${selectedModel.name} tidak mendukung chat completion. Pilih model chat lain.`,
        tokenUsage: null,
      };
    }

    const sessionTracker = getSessionTokenTracker(sessionId);
    const currentTokenStatus = buildModelStatus(selectedModel, sessionTracker);

    const history = sanitizeConversationHistory(conversationHistory);
    const contextLookupText = [
      userMessage,
      ...history.slice(-6).map((message) => message.content),
    ].join('\n');
    const contextData = await fetchContextData(contextLookupText);
    const lowerIntentText = contextLookupText.toLowerCase();
    const directResponse = buildDirectBusinessResponse(userMessage, contextData, contextLookupText);

    if (directResponse) {
      return {
        success: true,
        response: directResponse,
        tokenUsage: currentTokenStatus,
        selectedModel: selectedModel.id,
        modelResolvedByOpenRouter: 'app-data-direct-response',
        usage: {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
        },
        message: null,
      };
    }

    if (!process.env.OPENROUTER_API_KEY) {
      return {
        success: false,
        response: null,
        error: 'OPENROUTER_API_KEY tidak ditemukan',
        message: 'Layanan AI sedang tidak tersedia. Hubungi administrator.',
        tokenUsage: currentTokenStatus,
      };
    }

    const messages = [
      { role: 'system', content: buildSystemPrompt() },
      ...history,
    ];

    if (contextData) {
      messages.push({
        role: 'system',
        content: [
          'DATA APLIKASI TERBARU (gunakan sebagai sumber utama, jangan tampilkan struktur mentahnya):',
          ...contextData.map((ctx) => `${ctx.label}:\n${serializeContextPayload(ctx.value)}`),
          lowerIntentText.includes('stok') || lowerIntentText.includes('sisa') || lowerIntentText.includes('tersisa')
            ? 'CATATAN STOK: Untuk pertanyaan stok tersisa, prioritaskan saldo stok saat ini dari ringkasan stok bahan. Aktivitas stok masuk/keluar hanya menjadi penjelasan tambahan.'
            : null,
          'Ubah data di atas menjadi jawaban bisnis yang ramah user. Jangan menyebut database, API, query, field, kolom, JSON, atau label internal.',
        ].filter(Boolean).join('\n\n'),
      });
    }

    messages.push({
      role: 'system',
      content: [
        'PENGINGAT JAWABAN TERAKHIR SEBELUM MENJAWAB USER:',
        '- Wajib pakai bagian: Ringkasnya, Detail data, Saran berikutnya, Lanjut cek apa?',
        '- Jangan menyebut database, API, endpoint, query, integrasi, field, kolom, atau tim IT.',
        '- Jangan menyarankan cek masalah teknis. Gunakan saran operasional seperti cek transaksi yang dicatat, periode laporan, produk, stok, atau kasir/cabang.',
        '- Jika pertanyaan tentang hari ini, gunakan angka hari ini saja; jangan ganti dengan total periode.',
        '- Jika pertanyaan tentang stok tersisa, jawab saldo stok saat ini lebih dulu.',
      ].join('\n'),
    });

    messages.push({ role: 'user', content: userMessage });

    const maxCompletionTokens = resolveMaxCompletionTokens({
      requestedMaxTokens: options.maxTokens,
      modelConfig: selectedModel,
      tokenStatus: currentTokenStatus,
      messages,
    });

    if (maxCompletionTokens < 64) {
      return {
        success: false,
        response: null,
        error: 'Sisa token tidak cukup untuk menghasilkan jawaban',
        message: 'Sisa token model pada sesi ini terlalu kecil. Ganti model atau reset sesi.',
        tokenUsage: currentTokenStatus,
      };
    }

    let response;
    try {
      response = await axios.post(
        OPENROUTER_API_URL,
        {
          model: selectedModel.id,
          messages,
          max_tokens: maxCompletionTokens,
          temperature: 0.25,
          top_p: 0.9,
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
            'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'http://localhost:3000',
            'X-OpenRouter-Title': process.env.OPENROUTER_SITE_NAME || 'Kebab POS System',
            'Content-Type': 'application/json',
          },
          timeout: 35000,
        }
      );
    } catch (axiosError) {
      const nextFallbackModelId = getFallbackModelId(selectedModel.id, attemptedModelIds);

      if (axiosError.code === 'ECONNABORTED') {
        if (nextFallbackModelId) {
          return sendAIQuery(userMessage, conversationHistory, sessionId, {
            ...options,
            modelId: nextFallbackModelId,
            attemptedModelIds: [...attemptedModelIds, selectedModel.id],
          });
        }

        return {
          success: false,
          response: null,
          error: 'Request timeout',
          message: 'Koneksi ke AI service timeout. Coba lagi.',
          tokenUsage: currentTokenStatus,
        };
      }

      if (shouldFallbackFromProviderError(axiosError) && nextFallbackModelId) {
        console.warn(
          `[OpenRouter] Model ${selectedModel.id} gagal (${axiosError.response?.status || axiosError.code || axiosError.message}). Fallback ke ${nextFallbackModelId}.`
        );
        return sendAIQuery(userMessage, conversationHistory, sessionId, {
          ...options,
          modelId: nextFallbackModelId,
          attemptedModelIds: [...attemptedModelIds, selectedModel.id],
        });
      }

      if (axiosError.response?.status === 429) {
        if (nextFallbackModelId) {
          return sendAIQuery(userMessage, conversationHistory, sessionId, {
            ...options,
            modelId: nextFallbackModelId,
            attemptedModelIds: [...attemptedModelIds, selectedModel.id],
          });
        }

        return {
          success: false,
          response: null,
          error: 'Rate limit exceeded',
          message: 'Terlalu banyak permintaan. Tunggu sebentar lalu coba lagi.',
          tokenUsage: currentTokenStatus,
        };
      }

      if (axiosError.response?.status === 401) {
        return {
          success: false,
          response: null,
          error: 'Authentication failed',
          message: 'API key tidak valid. Hubungi administrator.',
          tokenUsage: currentTokenStatus,
        };
      }

      if (!axiosError.response) {
        return {
          success: false,
          response: null,
          error: 'Network error',
          message: 'Tidak dapat menghubungi AI service. Periksa koneksi internet.',
          tokenUsage: currentTokenStatus,
        };
      }

      const providerMessage =
        axiosError.response?.data?.error?.message ||
        axiosError.response?.data?.message ||
        axiosError.response?.data?.error ||
        axiosError.message;

      return {
        success: false,
        response: null,
        error: providerMessage,
        message: providerMessage || 'OpenRouter tidak dapat memproses request saat ini.',
        tokenUsage: currentTokenStatus,
      };
    }

    const aiResponse = response.data?.choices?.[0]?.message?.content;
    const usage = response.data?.usage || {};

    if (!aiResponse) {
      const nextFallbackModelId = getFallbackModelId(selectedModel.id, attemptedModelIds);

      if (nextFallbackModelId) {
        return sendAIQuery(userMessage, conversationHistory, sessionId, {
          ...options,
          modelId: nextFallbackModelId,
          attemptedModelIds: [...attemptedModelIds, selectedModel.id],
        });
      }

      return {
        success: false,
        response: null,
        error: 'Empty response from AI',
        message: 'AI tidak dapat memproses pertanyaan. Silakan coba lagi.',
        tokenUsage: currentTokenStatus,
      };
    }

    const tokensUsedThisRequest = Number(usage.total_tokens || 0);
    const modelTotalUsed = increasePerModelUsage(sessionTracker, selectedModel.id, tokensUsedThisRequest);
    const updatedTokenStatus = calculateTokenUsageStatus(
      modelTotalUsed,
      computeModelTokenLimit(selectedModel),
      selectedModel
    );

    return {
      success: true,
      response: aiResponse,
      tokenUsage: updatedTokenStatus,
      selectedModel: selectedModel.id,
      modelResolvedByOpenRouter: response.data?.model || selectedModel.id,
      usage: {
        promptTokens: Number(usage.prompt_tokens || 0),
        completionTokens: Number(usage.completion_tokens || 0),
        totalTokens: tokensUsedThisRequest,
      },
      message: updatedTokenStatus.isWarning
        ? `Penggunaan token model ini ${updatedTokenStatus.percentageUsed}% dari limit sesi model.`
        : null,
    };
  } catch (error) {
    console.error('OpenRouter AI Error:', error.message);
    if (error.response?.data) {
      console.error('API Error Details:', error.response.data);
    }

    const fallbackModel = getModelConfig(options.modelId);
    const sessionTracker = getSessionTokenTracker(sessionId);
    const tokenStatus = buildModelStatus(fallbackModel, sessionTracker);

    return {
      success: false,
      response: null,
      error: error.message,
      message: 'Terjadi error saat memproses permintaan. Coba lagi nanti.',
      tokenUsage: tokenStatus,
    };
  }
}

async function checkAIChatHealth() {
  try {
    if (!process.env.OPENROUTER_API_KEY) {
      return {
        status: 'error',
        message: 'OPENROUTER_API_KEY tidak ditemukan',
        connected: false,
      };
    }

    const testMessage = 'Halo, jawab singkat: fungsi utama Kebab POS apa?';
    const result = await sendAIQuery(testMessage, [], 'health-check', {
      modelId: getModelConfig().id,
      maxTokens: 120,
    });

    if (!result.success) {
      return {
        status: 'error',
        message: result.message || 'Tidak dapat menghubungi AI service',
        connected: false,
        error: result.error,
      };
    }

    return {
      status: 'ok',
      message: 'OpenRouter AI service is running',
      connected: true,
      model: result.selectedModel,
      resolvedModel: result.modelResolvedByOpenRouter,
      timestamp: new Date().toISOString(),
      testResponse: `${(result.response || '').substring(0, 100)}...`,
    };
  } catch (error) {
    return {
      status: 'error',
      message: error.message,
      connected: false,
      timestamp: new Date().toISOString(),
    };
  }
}

function clearSessionTokens(sessionId) {
  if (sessionTokenStore.has(sessionId)) {
    sessionTokenStore.delete(sessionId);
    return { success: true, message: `Session ${sessionId} cleared` };
  }
  return { success: false, message: `Session ${sessionId} not found` };
}

function getActiveSessions() {
  const sessions = [];

  for (const [sessionId, tracker] of sessionTokenStore.entries()) {
    const usageByModel = Object.entries(tracker.usageByModel).map(([modelId, used]) => {
      const modelConfig = getModelConfig(modelId);
      const tokenStatus = calculateTokenUsageStatus(used, computeModelTokenLimit(modelConfig), modelConfig);
      return {
        modelId,
        modelName: modelConfig.name,
        tokensUsed: used,
        tokenLimit: tokenStatus.tokenLimit,
        tokenUsagePercent: tokenStatus.percentageUsed,
        tokensRemaining: tokenStatus.tokensRemaining,
      };
    });

    sessions.push({
      sessionId,
      createdAt: tracker.createdAt,
      lastActivity: tracker.lastActivity,
      usageByModel,
    });
  }

  return sessions;
}

module.exports = {
  sendAIQuery,
  checkAIChatHealth,
  clearSessionTokens,
  getActiveSessions,
  calculateTokenUsageStatus,
  getAvailableChatModels,
};
