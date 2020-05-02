// This file implements the OAuth 2 flow to authenticate users with Reddit. See
// https://github.com/reddit-archive/reddit/wiki/oauth2 for details of Reddit's
// OAuth implementation, and https://tools.ietf.org/html/rfc6749 for information
// about OAuth more generally.

const polka = require('polka');
const fetch = require('node-fetch');
const log = require('another-logger');

const config = require('../../config');

/** The redirect URI for Discord to send the user back to. */
const redditRedirectURI = `${config.web.host}/auth/reddit/callback`;

/** The base of the URI that starts the OAuth flow. State is attached later. */
/* eslint-disable operator-linebreak */ // Long URIs suck
const redditAuthURIBase = 'https://old.reddit.com/api/v1/authorize'
	+ `?client_id=${config.reddit.clientID}`
	+ '&response_type=code'
	+ `&redirect_uri=${encodeURIComponent(redditRedirectURI)}`
	+ '&scope=identity'
	+ '&duration=permanent';
/* eslint-enable */

/**
 * Generates an auth URI to redirect the user to given a state.
 * @param {string} state
 * @returns {String}
 */
function authURI (state) {
	return `${redditAuthURIBase}&state=${encodeURIComponent(state)}`;
}

/**
 * Generates a formdata body from key-value pairs.
 * @param {object} content
 * @returns {Promise<string>}
 */
function formData (content) {
	return Object.entries(content)
		.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
		.join('&');
}

/**
 * Exchanges a code for an access/refresh token pair.
 * @param {string} code
 * @returns {Promise<object>} Object has keys `accessToken`, `refreshToken`,
 * `tokenType`, `scope`, and `expiresIn`. See Reddit documentation for more
 * detailed information.
 */
async function fetchRedditTokens (code) {
	const response = await fetch('https://www.reddit.com/api/v1/access_token', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			// HTTP basic auth, username = reddit client ID, pass = client secret
			'Authorization': `Basic ${Buffer.from(`${config.reddit.clientID}:${config.reddit.clientSecret}`).toString('base64')}`,
		},
		body: formData({
			grant_type: 'authorization_code',
			redirect_uri: config.reddit.redirectURI,
			code,
		}),
	});

	if (response.status !== 200) {
		throw new Error(`Reddit gave non-200 response status when requesting tokens: ${response.status}`);
	}

	const data = await response.json();
	if (data.error) {
		throw new Error(`Reddit gave an error when requesting tokens: ${data.error}`);
	}

	return {
		accessToken: data.access_token,
		refreshToken: data.refresh_token,
		tokenType: data.token_type,
		scope: data.scope,
		expiresIn: data.expires_in,
	};
}

/**
 * Fetches information about the user given their access token.
 * @param {string} accessToken
 * @returns {Promise<object>} Object has keys `name`, `avatarURL`, and
 * `accountAge`.
 */
async function fetchRedditUserInfo (accessToken) {
	log.info(accessToken);
	const response = await fetch('https://oauth.reddit.com/api/v1/me', {
		headers: {
			Authorization: `bearer ${accessToken}`,
		},
	});

	if (response.status !== 200) {
		throw new Error(`Reddit gave non-200 status when fetching user info: ${response.status}`);
	}

	const data = await response.json();
	return {
		name: data.name,
		avatarURL: data.subreddit && data.subreddit.icon_img,
		accountAge: new Date(data.created_utc * 1000),
	};
}

// Define routes
module.exports = polka()

	// OAuth entry point, generate a state and redirect to Reddit
	.get('/', (request, response) => {
		// TODO: Take a "next" parameter that specifies a location for the user to be sent to after the flow
		const state = `${Math.random()}`; // TODO: this should be secure
		request.session.redditState = state;
		response.redirect(authURI(state));
	})

	// OAuth flow has completed, time to authorize with Reddit
	.get('/callback', async (request, response) => {
		const {error, state, code} = request.query;

		// Check for errors or state mismatches
		if (error) {
			log.error('Reddit gave error after auth page:', error);
			response.end('uh-oh');
			return;
		}
		if (state !== request.session.redditState) {
			log.error('Reddit gave incorrect state after auth page: ', state, ', expected', request.session.state);
			response.end('uh-oh');
			return;
		}
		log.info(code);

		// Exchange the code for access/refresh tokens
		let tokens;
		try {
			tokens = await fetchRedditTokens(code);
		} catch (tokenError) {
			log.error('Error requesting Reddit access token:', tokenError);
			response.end('Error requesting Reddit authorization. Please try again. Contact a developer if the error persists.');
			return;
		}

		// Store tokens and expiry in the user's session
		request.session.redditAccessToken = tokens.accessToken;
		request.session.redditRefreshToken = tokens.refreshToken;
		// Make expiresIn into an absolute date, converting seconds to milliseconds along the way
		request.session.redditTokenExpiresAt = new Date(Date.now() + tokens.expiresIn * 1000);

		// Fetch Reddit user info and store in the user's session
		try {
			request.session.redditUserInfo = await fetchRedditUserInfo(tokens.accessToken);
		} catch (userInfoError) {
			log.error('Error fetching Reddit user info:', userInfoError);
			response.end('Error fetching your account details. Please try again. Contact a developer if the error persists.');
			return;
		}

		response.redirect('/');
	});