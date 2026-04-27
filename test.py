from groq import Groq

from dotenv import load_dotenv
load_dotenv()

import os

client = Groq(api_key=os.getenv("GROQ_API_KEY"))

txt = ""

with open("content.txt", "r") as f:
    txt = f.read()

while True:
    user_input = input("\n\nEnter your question: ")


    completion = client.chat.completions.create(
        model="llama-3.1-8b-instant",
        messages=[
        {
            "role": "system",
            "content": f"{txt}\n\nAnswer the following question based on the above content dont include any markdown text for answering and be very formal for answering. The user should understand everything easily if you need to answer in detail then answer just make it user friendliness and formal ."},

        {
            "role": "user", 
            "content": user_input},
        ],
        temperature=1,
        max_completion_tokens=1024,
        top_p=1,
        stream=True,
        stop=None
    )

    for chunk in completion:
        print(chunk.choices[0].delta.content or "", end="")
