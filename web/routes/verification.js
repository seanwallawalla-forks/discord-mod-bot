const polka = require('polka');
const log = require('another-logger');

module.exports = db => polka()

	// This route actually creates the relationship in the database
	.post('/', async (request, response) => {
		const reddit = request.session.redditUserInfo;
		if (!reddit) {
			response.writeHead(401);
			response.end('Not logged in with Reddit');
			return;
		}
		const discord = request.session.discordUserInfo;
		if (!discord) {
			response.writeHead(401);
			response.end('Not logged in with Discord');
			return;
		}

		// Check if the accounts are already linked

		try {
			// Check if this link is already recorded
			// TODO: implement this from Mongo via a compound primary key
			const existingLink = await db.collection('redditAccounts').findOne({
				userID: discord.id,
				redditName: reddit.name,
			});
			if (existingLink) {
				response.writeHead(201);
				response.end();
				return;
			}
			// Record the connection
			await db.collection('redditAccounts').insertOne({
				userID: request.session.discordUserInfo.id,
				redditName: request.session.redditUserInfo.name,
			});
		} catch (error) {
			log.error('Database error while processing reddit-discord link:', error);
			response.writeHead(500);
			response.end('An unexpected error occured. Get in touch with a bot developer.');
		}

		response.writeHead(201);
		response.end();
	})

	// This route is responsible for the frontend display
	.get('/', (request, response) => {
		const reddit = request.session.redditUserInfo;
		const discord = request.session.discordUserInfo;
		// TODO I really need to add a view engine lmao
		response.end(`
			<!DOCTYPE html>
			<html>
				<head>
					<meta charset="utf-8">
					<title>Verification</title>
				</head>
				<body>
					<p>Discord account: ${discord ? `${discord.username}#${discord.discriminator} (<a href="/auth/discord/logout?next=/verify">log out</a>)` : '<a href="/auth/discord?next=/verify">Connect</a>'}</p>
					<p>Reddit account: ${reddit ? `/u/${reddit.name} (<a href="/auth/reddit/logout?next=/verify">log out</a>)` : '<a href="/auth/reddit?next=/verify">Connect</a>'}</p>
					<p>${discord && reddit ? '<button onclick="linkAccounts()">Link Accounts</button>' : 'Connect a Reddit account and a Discord account to link them together.'}</p>
					<script>
						function linkAccounts () {
							fetch('/verify', {method: 'POST'}).then(response => {
								if (!response.ok) throw response;
								return response;
							}).then(() => {
								alert('Accounts linked successfully!');
							}).catch(() => {
								alert('Failed to link your accounts.');
							});
						}
					</script>
				</body>
			</html>
		`);
	});
