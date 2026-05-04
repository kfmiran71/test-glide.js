import express from "express";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("Server is running");
});

app.get("/push-arrivals", async (req, res) => {
  try {
    
   const arrivals = [
  {
    platformId: "235N",
    route: "3",
    time: "5 min",
    station: "Atlantic Av - Barclays",
    direction: "Uptown"
  },
  {
    platformId: "235N",
    route: "4",
    time: "2 min",
    station: "Atlantic Av - Barclays",
    direction: "Uptown"
  }
];
    console.log("PAYLOAD ARRIVALS:", arrivals);
    arrivals.forEach((a, i) => {
  console.log("ROW", i, {
    platformId: a.platformId,
    route: a.route,
    time: a.time,
    station: a.station,
    direction: a.direction
  });
});
    const response = await fetch("https://api.glideapp.io/api/function/mutateTables", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer d25737fc-2ba6-4dfa-bcc1-0b1150680e14"
      },
      body: JSON.stringify({
        appID: "TYenWzXz52pcp3wCTXG6",
           mutations: [
   
     ...arrivals.map(arrival => ({
       kind: "add-row-to-table",
       tableName: "native-table-d3UgJzNMFLdWdcIIc8AP",
       columnValues: {
         "Name": arrival.platformId,
         "wuIO9": arrival.route,
         "58c8P": arrival.time,
         "jQXCB": arrival.station,
         "Qfui6": arrival.direction
       }
     }))
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
