const express = require('express');
const bcrypt = require('bcrypt');

module.exports = function(db) {
    const router = express.Router();

    // Vendor Registration Endpoint
    router.post('/register', express.json(), async (req, res) => {
        // 1. We now extract 'pin' from the request body
        const { businessName, slug, customDomain, menuData, pin } = req.body;

        if (!businessName || !slug || !pin) {
            return res.status(400).json({ error: "Business name, slug, and pin are required." });
        }

        try {
            // 2. Strict Slug Sanitization (lowercase, no spaces, only letters/numbers/hyphens)
            const cleanSlug = slug.toLowerCase().trim().replace(/[^a-z0-9-]/g, '-');

            // 3. Hash the PIN (Cost factor of 10)
            const hashedPin = await bcrypt.hash(pin, 10);

            // 4. Update the SQL query to insert the hashed PIN
            const query = `INSERT INTO vendors (business_name, slug, custom_domain, menu_data, hashed_pin) VALUES (?, ?, ?, ?, ?)`;
            const params = [businessName, cleanSlug, customDomain || null, JSON.stringify(menuData || []), hashedPin];

            db.run(query, params, function(err) {
                if (err) {
                    // 5. Catch exact SQLite duplication errors
                    if (err.code === 'SQLITE_CONSTRAINT') {
                        return res.status(409).json({ error: "That subdomain or custom domain is already taken." });
                    }
                    console.error("DB Insert Error:", err);
                    return res.status(500).json({ error: "Failed to register vendor." });
                }
                
                res.status(201).json({
                    success: true,
                    vendorId: this.lastID,
                    slug: cleanSlug
                });
            });
        } catch (error) {
            console.error("Hashing Error:", error);
            res.status(500).json({ error: "Internal server error during registration." });
        }
    });

    return router;
};
