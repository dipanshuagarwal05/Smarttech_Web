import Groq from "groq-sdk";
import dotenv from "dotenv";
import fs from "fs";
import readline from "readline";

dotenv.config();

const client = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

const txt = fs.readFileSync("content.txt", "utf8");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

async function askQuestion() {
  rl.question("\nYou: ", async (userInput) => {
    if (userInput.toLowerCase() === "exit") {
      console.log("\nGoodbye!");
      rl.close();
      return;
    }

    process.stdout.write("\nAI: ");

    try {
      const completion = await client.chat.completions.create({
        model: "llama-3.1-8b-instant",
        messages: [
          {
            role: "system",
            content: `${txt}

Answer the following question based on the above content dont include any markdown text for answering and be very formal for answering. The user should understand everything easily if you need to answer in detail then answer just make it user friendliness and formal .`,
          },
          {
            role: "user",
            content: userInput,
          },
        ],
        stream: true,
      });

      for await (const chunk of completion) {
        process.stdout.write(
          chunk.choices[0]?.delta?.content || ""
        );
      }

      console.log("\n");
      askQuestion();
    } catch (error) {
      console.log("\nError:", error.message);
      askQuestion();
    }
  });
}

console.log("SmartTech Chatbot Started (type exit to quit)");
askQuestion();