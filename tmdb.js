const axios = require('axios');

const TMDB_API_KEY = process.env.TMDB_API_KEY;
const BASE_URL = 'https://api.themoviedb.org/3';

async function getMovieMeta(movieId) {
  const { data } = await axios.get(`${BASE_URL}/movie/${movieId}`, {
    params: { api_key: TMDB_API_KEY, language: 'en-US' },
  });
  return {
    tmdbId: data.id,
    title: data.title,
    originalTitle: data.original_title,
    year: data.release_date ? data.release_date.substring(0, 4) : null,
    poster: data.poster_path ? `https://image.tmdb.org/t/p/w500${data.poster_path}` : null,
    overview: data.overview,
    genres: data.genres.map(g => g.name),
    runtime: data.runtime,
    voteAverage: data.vote_average,
  };
}

async function getTvMeta(tvId, season, episode) {
  const [showRes, episodeRes] = await Promise.all([
    axios.get(`${BASE_URL}/tv/${tvId}`, { params: { api_key: TMDB_API_KEY } }),
    axios.get(`${BASE_URL}/tv/${tvId}/season/${season}/episode/${episode}`, {
      params: { api_key: TMDB_API_KEY },
    }),
  ]);
  const show = showRes.data;
  const ep = episodeRes.data;
  return {
    tmdbId: show.id,
    title: show.name,
    originalTitle: show.original_name,
    year: show.first_air_date ? show.first_air_date.substring(0, 4) : null,
    poster: show.poster_path ? `https://image.tmdb.org/t/p/w500${show.poster_path}` : null,
    overview: ep.overview || show.overview,
    genres: show.genres.map(g => g.name),
    episodeTitle: ep.name,
    season: ep.season_number,
    episode: ep.episode_number,
    runtime: ep.runtime || show.episode_run_time?.[0] || null,
    voteAverage: ep.vote_average,
  };
}

async function getSubtitles(type, id, season, episode) {
  let url;
  if (type === 'movie') {
    url = `${BASE_URL}/movie/${id}/translations`;
  } else {
    url = `${BASE_URL}/tv/${id}/translations`;
  }
  const { data } = await axios.get(url, { params: { api_key: TMDB_API_KEY } });
  return data.translations
    .filter(t => t.iso_639_1)
    .map(t => ({
      label: t.english_name,
      file: null,
      type: 'text/vtt',
      source: 'tmdb',
    }));
}

module.exports = { getMovieMeta, getTvMeta, getSubtitles };