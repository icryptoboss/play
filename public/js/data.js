// Vega Media Catalog & Sample Dataset
const VEGA_ACCENTS = [
  { name: 'Vega', color: '#FF6347' },
  { name: 'Hayasaka', color: '#00e6e6' },
  { name: 'Lavender', color: '#B2A4D4' },
  { name: 'Sky', color: '#87CEEB' },
  { name: 'Mint', color: '#98FB98' },
  { name: 'Sunset', color: '#FFA07A' },
  { name: 'Flix', color: '#E50914' },
  { name: 'Material', color: '#2196F3' },
  { name: 'Custom', color: '#FFFFFF' }
];

const VEGA_PROVIDERS = [
  {
    id: 'vega-stream-core',
    name: 'Vega Core Multi-Source',
    version: 'v2.4.1',
    description: 'Ultra-fast multi-source streaming provider with 4K UHD and multi-language audio.',
    type: 'Video / Movies & Series',
    enabled: true,
    rating: '5.0',
    downloads: '1.2M'
  },
  {
    id: 'anime-hub-v2',
    name: 'AnimeHub Ultimate',
    version: 'v1.8.0',
    description: 'Subbed and dubbed high-definition anime catalogue with auto-skip intro.',
    type: 'Anime & Manga',
    enabled: true,
    rating: '4.9',
    downloads: '850K'
  },
  {
    id: 'cinema-hd-direct',
    name: 'CinemaHD Global Stream',
    version: 'v3.1.2',
    description: 'Global film aggregator with direct HLS links and Dolby Atmos tracks.',
    type: 'Movies / Live Feeds',
    enabled: true,
    rating: '4.8',
    downloads: '940K'
  },
  {
    id: 'opensubtitles-pro',
    name: 'OpenSubtitles v3 Integration',
    version: 'v2.0.4',
    description: 'Automatic multilingual subtitle sync for all media with custom font support.',
    type: 'Subtitles & Captions',
    enabled: true,
    rating: '4.9',
    downloads: '2.1M'
  }
];

const VEGA_CATALOG = [
  {
    id: 'dune-part-two',
    title: 'Dune: Part Two',
    type: 'movie',
    year: '2024',
    rating: '8.7',
    quality: '4K HDR',
    duration: '2h 46m',
    genres: ['Sci-Fi', 'Adventure', 'Action'],
    poster: 'https://images.unsplash.com/photo-1534447677768-be436bb09401?auto=format&fit=crop&w=600&q=80',
    backdrop: 'https://images.unsplash.com/photo-1509198397868-475647b2a1e5?auto=format&fit=crop&w=1920&q=85',
    overview: 'Paul Atreides unites with Chani and the Fremen while seeking revenge against the conspirators who destroyed his family. Facing a choice between the love of his life and the fate of the known universe, he endeavors to prevent a terrible future only he can foresee.',
    cast: ['Timothée Chalamet', 'Zendaya', 'Rebecca Ferguson', 'Javier Bardem'],
    directors: ['Denis Villeneuve'],
    videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
    featured: true
  },
  {
    id: 'cyberpunk-edgerunners',
    title: 'Cyberpunk: Edgerunners',
    type: 'anime',
    year: '2023',
    rating: '8.9',
    quality: '1080p FHD',
    duration: '1 Season',
    genres: ['Anime', 'Sci-Fi', 'Action'],
    poster: 'https://images.unsplash.com/photo-1578632767115-351597cf2477?auto=format&fit=crop&w=600&q=80',
    backdrop: 'https://images.unsplash.com/photo-1542751371-adc38448a05e?auto=format&fit=crop&w=1920&q=85',
    overview: 'A street kid trying to survive in a technology and body modification-obsessed city of the future. Having everything to lose, he chooses to stay alive by becoming an edgerunner: a mercenary outlaw also known as a cyberpunk.',
    cast: ['KENN', 'Aoi Yuuki', 'Hiroki Touchi'],
    directors: ['Hiroyuki Imaishi'],
    videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4',
    featured: false,
    episodes: [
      { ep: 1, title: 'Let You Down', duration: '24m', thumb: 'https://images.unsplash.com/photo-1542751371-adc38448a05e?auto=format&fit=crop&w=400&q=80' },
      { ep: 2, title: 'Like a Boy', duration: '25m', thumb: 'https://images.unsplash.com/photo-1578632767115-351597cf2477?auto=format&fit=crop&w=400&q=80' },
      { ep: 3, title: 'Smooth Criminal', duration: '23m', thumb: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?auto=format&fit=crop&w=400&q=80' }
    ]
  },
  {
    id: 'interstellar',
    title: 'Interstellar',
    type: 'movie',
    year: '2014',
    rating: '8.9',
    quality: '4K HDR',
    duration: '2h 49m',
    genres: ['Sci-Fi', 'Drama', 'Adventure'],
    poster: 'https://images.unsplash.com/photo-1451187580459-43490279c0fa?auto=format&fit=crop&w=600&q=80',
    backdrop: 'https://images.unsplash.com/photo-1446776811953-b23d57bd21aa?auto=format&fit=crop&w=1920&q=85',
    overview: 'When Earth becomes uninhabitable in the future, a farmer and ex-NASA pilot, Joseph Cooper, is tasked to pilot a spacecraft, along with a team of researchers, to find a new planet for humans.',
    cast: ['Matthew McConaughey', 'Anne Hathaway', 'Jessica Chastain'],
    directors: ['Christopher Nolan'],
    videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4',
    featured: true
  },
  {
    id: 'arcane-league',
    title: 'Arcane: League of Legends',
    type: 'series',
    year: '2024',
    rating: '9.0',
    quality: '4K Dolby Vision',
    duration: '2 Seasons',
    genres: ['Animation', 'Action', 'Sci-Fi'],
    poster: 'https://images.unsplash.com/photo-1563089145-599997674d42?auto=format&fit=crop&w=600&q=80',
    backdrop: 'https://images.unsplash.com/photo-1511512578047-dfb367046420?auto=format&fit=crop&w=1920&q=85',
    overview: 'Set in the utopian region of Piltover and the oppressed underground of Zaun, the story follows the origins of two iconic League champions-and the power that will tear them apart.',
    cast: ['Hailee Steinfeld', 'Ella Purnell', 'Kevin Alejandro'],
    directors: ['Pascal Charrue', 'Arnaud Delord'],
    videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4',
    featured: false,
    episodes: [
      { ep: 1, title: 'Welcome to the Playground', duration: '41m', thumb: 'https://images.unsplash.com/photo-1563089145-599997674d42?auto=format&fit=crop&w=400&q=80' },
      { ep: 2, title: 'Some Mysteries Are Better Left Unsolved', duration: '44m', thumb: 'https://images.unsplash.com/photo-1511512578047-dfb367046420?auto=format&fit=crop&w=400&q=80' },
      { ep: 3, title: 'The Base Violence Necessary for Change', duration: '45m', thumb: 'https://images.unsplash.com/photo-1550745165-9bc0b252726f?auto=format&fit=crop&w=400&q=80' }
    ]
  },
  {
    id: 'blade-runner-2049',
    title: 'Blade Runner 2049',
    type: 'movie',
    year: '2017',
    rating: '8.5',
    quality: '4K HDR',
    duration: '2h 44m',
    genres: ['Sci-Fi', 'Mystery', 'Thriller'],
    poster: 'https://images.unsplash.com/photo-1508739773434-c26b3d09e071?auto=format&fit=crop&w=600&q=80',
    backdrop: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?auto=format&fit=crop&w=1920&q=85',
    overview: 'Young Blade Runner K\'s discovery of a long-buried secret leads him to track down former Blade Runner Rick Deckard, who\'s been missing for thirty years.',
    cast: ['Ryan Gosling', 'Harrison Ford', 'Ana de Armas'],
    directors: ['Denis Villeneuve'],
    videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
    featured: false
  },
  {
    id: 'stranger-things',
    title: 'Stranger Things',
    type: 'series',
    year: '2024',
    rating: '8.8',
    quality: '4K HDR',
    duration: '4 Seasons',
    genres: ['Sci-Fi', 'Horror', 'Drama'],
    poster: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?auto=format&fit=crop&w=600&q=80',
    backdrop: 'https://images.unsplash.com/photo-1509198397868-475647b2a1e5?auto=format&fit=crop&w=1920&q=85',
    overview: 'When a young boy vanishes, a small town uncovers a mystery involving secret experiments, terrifying supernatural forces and one strange little girl.',
    cast: ['Millie Bobby Brown', 'Finn Wolfhard', 'Winona Ryder'],
    directors: ['The Duffer Brothers'],
    videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4',
    featured: false,
    episodes: [
      { ep: 1, title: 'Chapter One: The Vanishing', duration: '49m', thumb: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?auto=format&fit=crop&w=400&q=80' },
      { ep: 2, title: 'Chapter Two: The Weirdo', duration: '55m', thumb: 'https://images.unsplash.com/photo-1508739773434-c26b3d09e071?auto=format&fit=crop&w=400&q=80' }
    ]
  },
  {
    id: 'attack-on-titan',
    title: 'Attack on Titan: Final Season',
    type: 'anime',
    year: '2023',
    rating: '9.1',
    quality: '1080p FHD',
    duration: '4 Seasons',
    genres: ['Anime', 'Action', 'Fantasy'],
    poster: 'https://images.unsplash.com/photo-1579783902614-a3fb3927b675?auto=format&fit=crop&w=600&q=80',
    backdrop: 'https://images.unsplash.com/photo-1534447677768-be436bb09401?auto=format&fit=crop&w=1920&q=85',
    overview: 'After his hometown is destroyed and his mother is killed, young Eren Jaeger vows to cleanse the earth of the giant humanoid Titans that have brought humanity to the brink of extinction.',
    cast: ['Yuki Kaji', 'Yui Ishikawa', 'Marina Inoue'],
    directors: ['Tetsuro Araki', 'Yuichiro Hayashi'],
    videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4',
    featured: false,
    episodes: [
      { ep: 1, title: 'The Other Side of the Sea', duration: '24m', thumb: 'https://images.unsplash.com/photo-1579783902614-a3fb3927b675?auto=format&fit=crop&w=400&q=80' },
      { ep: 2, title: 'Midnight Train', duration: '24m', thumb: 'https://images.unsplash.com/photo-1534447677768-be436bb09401?auto=format&fit=crop&w=400&q=80' }
    ]
  },
  {
    id: 'the-batman',
    title: 'The Batman',
    type: 'movie',
    year: '2022',
    rating: '8.3',
    quality: '4K HDR',
    duration: '2h 56m',
    genres: ['Action', 'Crime', 'Drama'],
    poster: 'https://images.unsplash.com/photo-1509198397868-475647b2a1e5?auto=format&fit=crop&w=600&q=80',
    backdrop: 'https://images.unsplash.com/photo-1508739773434-c26b3d09e071?auto=format&fit=crop&w=1920&q=85',
    overview: 'When a sadistic serial killer begins murdering key political figures in Gotham, Batman is forced to investigate the city\'s hidden corruption and question his family\'s involvement.',
    cast: ['Robert Pattinson', 'Zoë Kravitz', 'Paul Dano'],
    directors: ['Matt Reeves'],
    videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4',
    featured: false
  }
];

const VEGA_CONTINUE_WATCHING = [
  {
    id: 'dune-part-two',
    title: 'Dune: Part Two',
    episodeTitle: 'Main Feature',
    progress: 0.68,
    durationText: '1h 52m / 2h 46m',
    image: 'https://images.unsplash.com/photo-1509198397868-475647b2a1e5?auto=format&fit=crop&w=600&q=80',
    type: 'movie'
  },
  {
    id: 'cyberpunk-edgerunners',
    title: 'Cyberpunk: Edgerunners',
    episodeTitle: 'S1:E3 • Smooth Criminal',
    progress: 0.45,
    durationText: '11m / 23m',
    image: 'https://images.unsplash.com/photo-1542751371-adc38448a05e?auto=format&fit=crop&w=600&q=80',
    type: 'anime'
  },
  {
    id: 'arcane-league',
    title: 'Arcane',
    episodeTitle: 'S2:E1 • Heavy is the Crown',
    progress: 0.82,
    durationText: '34m / 41m',
    image: 'https://images.unsplash.com/photo-1563089145-599997674d42?auto=format&fit=crop&w=600&q=80',
    type: 'series'
  }
];

const VEGA_DOWNLOADS = [
  {
    id: 'dune-part-two',
    title: 'Dune: Part Two',
    size: '8.4 GB',
    quality: '4K UHD • HEVC',
    progress: 1.0,
    status: 'Completed',
    image: 'https://images.unsplash.com/photo-1534447677768-be436bb09401?auto=format&fit=crop&w=400&q=80'
  },
  {
    id: 'interstellar',
    title: 'Interstellar',
    size: '12.1 GB',
    quality: '4K IMAX • Dolby Atmos',
    progress: 0.74,
    status: 'Downloading (18.4 MB/s)',
    image: 'https://images.unsplash.com/photo-1451187580459-43490279c0fa?auto=format&fit=crop&w=400&q=80'
  }
];
