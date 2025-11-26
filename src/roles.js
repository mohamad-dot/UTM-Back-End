// ROLES ENDPOINTS
const roles = (app, queryDatabase) => {
    // Get the name of a specific role
    app.get("/drma/roles/:role_id", async (req, res) => {
        try {
            // Get the role ID from the route parameters
            const { role_id } = req.params;

            // Validate that role_id is provided
            if (!role_id) {
                return res.status(400).json({ error: "role_id is required" });
            }

            // Query to fetch role name based on role ID
            const query = `
                SELECT DRMAROL_name
                FROM DRMA_Roles
                WHERE DRMAROL_id = ?
            `;

            // Execute the query with the role ID as a parameter
            const result = await queryDatabase(query, [role_id]);

            // If no results are found, return a 404 error
            if (!result || result.length === 0) {
                return res.status(404).json({ error: "Role not found" });
            }

            // Return the role name
            res.status(200).json({ roleName: result[0].DRMAROL_name });
        } catch (error) {
            console.error("Error fetching role name:", error);
            res.status(500).json({ error: "Failed to fetch role name. Please try again later." });
        }
    });
};

export default roles;