// Offline fallback: keyword + domain heuristic (used when the AI is unavailable, and as the
// "no AI" provider). Produces the same shape as the model and goes through the same validation.
import { foldText, nameKey, tokenize } from './text.js';
import { siteLabel } from './url.js';
import { contextFromRequest, normalizeClassification } from './validate.js';

/**
 * Categories: `domains` match host labels ("lacentrale"), dotted host fragments ("guide.michelin")
 * or host + path prefixes ("linkedin.com/jobs"). Domain hits weigh 3; `weak` domains (generic
 * platforms such as TripAdvisor or YouTube that serve many intents) and keyword hits weigh 1.
 * Keywords are folded (no accents) and matched as whole words; a plural "s"/"x" is tolerated.
 */
const CATEGORIES = [
  {
    key: 'cars', emoji: '🚗', color: 'blue', names: { fr: 'Voitures', en: 'Cars' },
    domains: ['lacentrale', 'autoplus', 'caradisiac', 'autoscout24', 'aramisauto', 'largus', 'autojournal', 'turbo.fr', 'spoticar', 'autohero', 'motor1', 'leboncoin.fr/voitures', 'cars.com', 'autotrader', 'carvana', 'edmunds', 'kbb'],
    keywords: ['voiture', 'auto', 'automobile', 'suv', 'berline', 'citadine', 'monospace', 'occasion', 'concessionnaire', 'concession', 'leasing', 'lld', 'loa', 'peugeot', 'renault', 'citroen', 'dacia', 'tesla', 'bmw', 'audi', 'volkswagen', 'toyota', 'kia', 'hyundai', 'mercedes', 'fiat', 'ford', 'opel', 'skoda', 'cupra', 'nissan', 'byd', 'volvo', 'porsche', 'jeep', 'mazda', 'honda', 'lexus', 'pneu', 'vehicule'],
  },
  {
    key: 'restaurants', emoji: '🍽️', color: 'orange', names: { fr: 'Restaurants', en: 'Restaurants' },
    domains: ['thefork', 'lafourchette', 'ubereats', 'deliveroo', 'just-eat', 'opentable', 'yelp', 'zenchef', 'guide.michelin', 'lefooding', 'bigmammagroup'],
    weak: ['tripadvisor'],
    keywords: ['restaurant', 'resto', 'brasserie', 'bistrot', 'bistro', 'pizzeria', 'trattoria', 'sushi', 'ramen', 'burger', 'brunch', 'gastronomique', 'gastronomie', 'traiteur', 'livraison repas', 'reserver une table', 'dining'],
  },
  {
    key: 'travel', emoji: '✈️', color: 'cyan', names: { fr: 'Voyage', en: 'Travel' },
    domains: ['booking', 'airbnb', 'expedia', 'skyscanner', 'kayak', 'opodo', 'edreams', 'lastminute', 'trivago', 'hotels.com', 'airfrance', 'easyjet', 'ryanair', 'transavia', 'vueling', 'lufthansa', 'sncf-connect', 'trainline', 'ouigo', 'routard', 'lonelyplanet', 'getyourguide', 'civitatis'],
    weak: ['tripadvisor', 'google.com/travel'],
    keywords: ['vol', 'flight', 'avion', 'aeroport', 'airport', 'hotel', 'auberge', 'hostel', 'sejour', 'vacances', 'voyage', 'travel', 'trip', 'visa', 'itineraire', 'croisiere', 'cruise', 'tgv', 'que faire a', 'things to do', 'incontournables', 'road trip', 'billet d avion'],
  },
  {
    key: 'work', emoji: '💼', color: 'grey', names: { fr: 'Travail', en: 'Work' },
    domains: ['slack', 'atlassian', 'trello', 'asana', 'monday.com', 'clickup', 'teams.microsoft', 'outlook.office', 'zoom.us', 'meet.google', 'figma', 'miro', 'linear.app', 'salesforce', 'hubspot'],
    weak: ['notion', 'docs.google', 'drive.google', 'calendar.google'],
    keywords: ['reunion', 'meeting', 'sprint', 'roadmap', 'okr', 'backlog', 'compte rendu', 'kpi', 'devis', 'facture', 'agenda'],
  },
  {
    key: 'dev', emoji: '💻', color: 'purple', names: { fr: 'Développement', en: 'Development' },
    domains: ['github', 'gitlab', 'bitbucket', 'stackoverflow', 'stackexchange', 'developer.mozilla', 'npmjs', 'pypi', 'docs.python', 'devdocs', 'w3schools', 'codepen', 'jsfiddle', 'replit', 'vercel', 'netlify', 'readthedocs', 'dev.to', 'react.dev', 'nextjs', 'typescriptlang'],
    keywords: ['javascript', 'typescript', 'python', 'rust', 'golang', 'react', 'angular', 'vuejs', 'nodejs', 'node js', 'api', 'sdk', 'docker', 'kubernetes', 'git', 'css', 'sql', 'regex', 'programmation', 'programming', 'debug', 'compiler', 'framework', 'pandas', 'useeffect'],
  },
  {
    key: 'study', emoji: '📚', color: 'green', names: { fr: 'Études', en: 'Studies' },
    domains: ['coursera', 'udemy', 'edx', 'khanacademy', 'openclassrooms', 'maths-et-tiques', 'kartable', 'schoolmouv', 'quizlet', 'scholar.google', 'arxiv', 'cairn', 'moodle', 'classroom.google', 'letudiant', 'annabac'],
    keywords: ['cours', 'course', 'lecon', 'exercice', 'corrige', 'examen', 'exam', 'revision', 'bac', 'brevet', 'partiel', 'universite', 'university', 'lycee', 'mooc', 'quiz', 'maths', 'mathematiques', 'math', 'physique', 'chimie', 'biologie', 'philosophie', 'theoreme', 'equation', 'derivee', 'integrale', 'grammaire', 'conjugaison', 'annales', 'tutorat'],
  },
  {
    key: 'shopping', emoji: '🛍️', color: 'pink', names: { fr: 'Shopping', en: 'Shopping' },
    domains: ['amazon', 'fnac', 'cdiscount', 'darty', 'boulanger', 'ebay', 'aliexpress', 'temu', 'shein', 'zalando', 'asos', 'vinted', 'ikea', 'leroymerlin', 'decathlon', 'etsy', 'rakuten', 'veepee', 'ldlc', 'backmarket', 'lesnumeriques', 'idealo'],
    weak: ['leboncoin'],
    keywords: ['acheter', 'achat', 'panier', 'cart', 'promo', 'promotion', 'soldes', 'prix', 'livraison gratuite', 'boutique', 'shop', 'deal', 'comparatif', 'meilleur rapport qualite prix', 'casque', 'smartphone'],
  },
  {
    key: 'news', emoji: '📰', color: 'red', names: { fr: 'Actualités', en: 'News' },
    domains: ['lemonde', 'lefigaro', 'liberation', 'franceinfo', 'francetvinfo', '20minutes', 'bfmtv', 'leparisien', 'ouest-france', 'lesechos', 'mediapart', 'huffingtonpost', 'bbc', 'cnn', 'nytimes', 'theguardian', 'reuters', 'apnews', 'washingtonpost', 'news.google', 'lexpress', 'lepoint', 'nouvelobs', 'france24', 'euronews'],
    keywords: ['actualite', 'actu', 'news', 'breaking', 'politique', 'election'],
  },
  {
    key: 'entertainment', emoji: '🎬', color: 'purple', names: { fr: 'Divertissement', en: 'Entertainment' },
    domains: ['netflix', 'primevideo', 'disneyplus', 'canalplus', 'mycanal', 'twitch', 'crunchyroll', 'allocine', 'imdb', 'senscritique', 'spotify', 'deezer', 'soundcloud', 'arte.tv', 'france.tv'],
    weak: ['youtube'],
    keywords: ['film', 'movie', 'serie', 'episode', 'saison', 'season', 'trailer', 'bande annonce', 'streaming', 'musique', 'music', 'album', 'concert', 'playlist'],
  },
  {
    key: 'finance', emoji: '💰', color: 'yellow', names: { fr: 'Finances', en: 'Finance' },
    domains: ['boursorama', 'zonebourse', 'investing.com', 'tradingview', 'coinbase', 'binance', 'kraken', 'finance.yahoo', 'revolut', 'impots.gouv'],
    keywords: ['bourse', 'etf', 'crypto', 'bitcoin', 'ethereum', 'investissement', 'investir', 'placement', 'epargne', 'livret', 'assurance vie', 'credit', 'pret', 'impot', 'budget'],
  },
  {
    key: 'housing', emoji: '🏠', color: 'yellow', names: { fr: 'Logement', en: 'Housing' },
    domains: ['seloger', 'pap.fr', 'logic-immo', 'bienici', 'leboncoin.fr/locations', 'leboncoin.fr/ventes_immobilieres', 'lacartedescolocs', 'meilleursagents', 'orpi', 'century21', 'foncia', 'zillow', 'rightmove', 'idealista', 'nextories', 'demenager'],
    keywords: ['appartement', 'appart', 'maison', 'loyer', 'immobilier', 'colocation', 'coloc', 'logement', 'demenagement', 'demenageur', 'bail', 'apartment', 'real estate', 'rent'],
  },
  {
    key: 'jobs', emoji: '🧑‍💼', color: 'cyan', names: { fr: 'Emploi', en: 'Jobs' },
    domains: ['indeed', 'welcometothejungle', 'linkedin.com/jobs', 'monster', 'hellowork', 'apec', 'francetravail', 'glassdoor', 'jobteaser', 'cadremploi', 'malt'],
    keywords: ['emploi', 'job', 'candidature', 'cv', 'lettre de motivation', 'recrutement', 'stage', 'alternance', 'salaire', 'embauche', 'career', 'hiring', 'internship'],
  },
  {
    key: 'social', emoji: '💬', color: 'pink', names: { fr: 'Réseaux sociaux', en: 'Social media' },
    domains: ['facebook', 'instagram', 'twitter', 'x.com', 'tiktok', 'reddit', 'snapchat', 'pinterest', 'threads.net', 'bsky.app', 'discord', 'mastodon'],
    weak: ['linkedin'],
    keywords: [],
  },
  {
    key: 'sport', emoji: '⚽', color: 'green', names: { fr: 'Sport', en: 'Sports' },
    domains: ['lequipe', 'eurosport', 'rmcsport', 'sofoot', 'footmercato', 'espn', 'skysports', 'nba.com', 'uefa', 'fifa', 'ligue1', 'strava'],
    keywords: ['foot', 'football', 'ligue', 'psg', 'nba', 'tennis', 'rugby', 'basket', 'marathon', 'running', 'cyclisme', 'musculation', 'fitness', 'entrainement', 'workout', 'champions league', 'mercato'],
  },
  {
    key: 'health', emoji: '🩺', color: 'red', names: { fr: 'Santé', en: 'Health' },
    domains: ['doctolib', 'ameli', 'vidal', 'doctissimo', 'passeportsante', 'mayoclinic', 'webmd', 'nhs.uk', 'sante.fr', 'maiia', 'qare'],
    keywords: ['sante', 'medecin', 'docteur', 'symptome', 'maladie', 'traitement', 'pharmacie', 'medicament', 'dentiste', 'kine', 'hopital', 'vaccin', 'health'],
  },
  {
    key: 'cooking', emoji: '🥘', color: 'orange', names: { fr: 'Cuisine', en: 'Cooking' },
    domains: ['marmiton', '750g', 'cuisineaz', 'cuisineactuelle', 'allrecipes', 'bbcgoodfood', 'seriouseats', 'ricardocuisine', 'chefclub', 'hellofresh'],
    keywords: ['recette', 'recipe', 'ingredient', 'cuisson', 'gateau', 'dessert', 'patisserie', 'cuisiner', 'tiramisu', 'pate a pizza', 'pates fraiches'],
  },
  {
    key: 'games', emoji: '🎮', color: 'purple', names: { fr: 'Jeux vidéo', en: 'Games' },
    domains: ['steampowered', 'epicgames', 'jeuxvideo.com', 'gamekult', 'ign', 'gamespot', 'nintendo', 'playstation', 'xbox', 'chess.com', 'lichess', 'roblox'],
    keywords: ['jeux', 'game', 'gaming', 'gameplay', 'soluce', 'walkthrough', 'ps5', 'steam', 'fortnite', 'minecraft', 'zelda', 'pokemon'],
  },
  {
    key: 'admin', emoji: '🏛️', color: 'grey', names: { fr: 'Démarches', en: 'Paperwork' },
    domains: ['service-public.fr', 'ants.gouv', 'caf.fr', 'urssaf', 'franceconnect'],
    keywords: ['demarche', 'formulaire', 'passeport', 'carte d identite', 'prefecture', 'titre de sejour', 'changement d adresse', 'declaration'],
  },
];

const DOMAIN_WEIGHT = 3;
const WEAK_DOMAIN_WEIGHT = 1;
const KEYWORD_WEIGHT = 1;

// Multi-purpose sites: two of their tabs are usually unrelated, so they are never grouped "by site".
const NO_SITE_GROUPING = new Set(['google', 'bing', 'duckduckgo', 'yahoo', 'qwant', 'ecosia', 'brave', 'startpage', 'perplexity', 'youtube', 'wikipedia', 'reddit']);

function compileCategory(category) {
  const words = new Set();
  const phrases = [];
  for (const keyword of category.keywords) {
    const folded = foldText(keyword);
    if (folded.includes(' ')) phrases.push(` ${folded} `);
    else words.add(folded);
  }
  return { ...category, weak: category.weak ?? [], words, phrases };
}

const COMPILED = CATEGORIES.map(compileCategory);

function hostMatches(host, path, hint) {
  const slash = hint.indexOf('/');
  if (slash !== -1) {
    return hostMatches(host, '', hint.slice(0, slash)) && path.startsWith(hint.slice(slash));
  }
  if (hint.includes('.')) return `.${host}.`.includes(`.${hint}.`);
  return host.split('.').includes(hint);
}

function stemmed(token) {
  return token.length > 3 && /[sx]$/.test(token) ? token.slice(0, -1) : token;
}

function pathOf(tab) {
  return tab.url && tab.url.includes('/') ? tab.url.slice(tab.url.indexOf('/')) : '';
}

function textOf(tab) {
  const path = pathOf(tab)
    .replace(/\.(?:s?html?|php\d?|aspx?|jsp|cfm)\b/gi, ' ')
    .replace(/[/_.-]+/g, ' ');
  return `${tab.title ?? ''} ${tab.query ?? ''} ${path}`;
}

/** Best category for a tab-like object ({title, query, domain, url}), or null. */
export function categorize(tab) {
  const host = tab.domain ?? '';
  const path = pathOf(tab);
  const tokens = tokenize(textOf(tab));
  const tokenSet = new Set([...tokens, ...tokens.map(stemmed)]);
  const joined = ` ${tokens.join(' ')} `;

  let best = null;
  let bestScore = 0;
  for (const category of COMPILED) {
    let score = 0;
    if (host && category.domains.some((hint) => hostMatches(host, path, hint))) score += DOMAIN_WEIGHT;
    else if (host && category.weak.some((hint) => hostMatches(host, path, hint))) score += WEAK_DOMAIN_WEIGHT;
    for (const word of category.words) if (tokenSet.has(word)) score += KEYWORD_WEIGHT;
    for (const phrase of category.phrases) if (joined.includes(phrase)) score += KEYWORD_WEIGHT;
    if (score > bestScore) [best, bestScore] = [category, score];
  }
  return best;
}

function categoryOfExistingGroup(group) {
  return categorize({ title: `${group.name} ${(group.examples ?? []).join(' ')}`, domain: '', query: null, url: null });
}

/**
 * @param {ReturnType<import('./request.js').normalizeClassifyRequest>} request normalised request
 */
export function classifyHeuristically(request) {
  const { language } = request;
  const existingByCategory = new Map();
  for (const group of request.existingGroups) {
    const category = categoryOfExistingGroup(group);
    if (category && !existingByCategory.has(category.key)) existingByCategory.set(category.key, group);
  }

  const byCategory = new Map();
  const leftovers = [];
  for (const tab of request.tabs) {
    const category = categorize(tab);
    if (!category) {
      leftovers.push(tab);
      continue;
    }
    if (!byCategory.has(category.key)) byCategory.set(category.key, { category, tabs: [] });
    byCategory.get(category.key).tabs.push(tab);
  }

  const groups = [];
  for (const { category, tabs } of byCategory.values()) {
    const tabIds = tabs.map((tab) => tab.id);
    const existing = existingByCategory.get(category.key);
    if (existing) {
      groups.push({ name: existing.name, emoji: '', color: existing.color, existingGroupId: existing.id, tabIds });
    } else if (tabs.length >= 2) {
      const name = category.names[language] ?? category.names.en;
      groups.push({ name, emoji: category.emoji, color: category.color, existingGroupId: null, tabIds });
    } else {
      leftovers.push(...tabs);
    }
  }

  // Uncategorised tabs: group by site when a site has several tabs.
  const bySite = new Map();
  for (const tab of leftovers) {
    const label = siteLabel(tab.domain);
    if (!label || NO_SITE_GROUPING.has(label)) continue;
    if (!bySite.has(label)) bySite.set(label, []);
    bySite.get(label).push(tab.id);
  }
  for (const [label, tabIds] of bySite) {
    if (tabIds.length < 2) continue;
    const name = label.charAt(0).toUpperCase() + label.slice(1);
    const existing = request.existingGroups.find((group) => nameKey(group.name) === nameKey(name));
    groups.push({ name, emoji: '🌐', color: null, existingGroupId: existing ? existing.id : null, tabIds });
  }

  return normalizeClassification({ groups, ungrouped: [] }, contextFromRequest(request));
}
