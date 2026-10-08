module.exports = {
    apps: [{
        name: "ticketcheckin",
        script: "./server.js",
        watch: true,
        ignore_watch: ["node_modules", "db.json", ".db.json.tmp", "sessions", ".git"],
        env: {
            NODE_ENV: "production",
        }
    }]
}
