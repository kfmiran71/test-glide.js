import express from "express";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("Server is running");
});

app.get("/push-arrivals", async (req, res) => {
  try {
    const response = await fetch("https://api.glideapp.io/api/function/mutateTables", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer d25737fc-2ba6-4dfa-bcc1-0b1150680e14"
      },
      body: JSON.stringify({
        appID: "TYenWzXz52pcp3wCTXG6",
        mutations: [
          {
            kind: "add-row-to-table",
            tableName: "native-table-d3UgJzNMFLdWdcIIc8AP",
            columnValues: {
 "Name": "TEST",
"wuIO9": "X",
"58c8P": "0 min",
"jQXCB": "Unknown",
"Qfui6": "Unknown"
}
          }
        ]
      })
    });

    const text = await response.text();

    res.json({
      status: response.status,
      ok: response.ok,
      response: text
    });

  } catch (err) {
    res.json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
