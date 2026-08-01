// Vercel Serverless Function for AI Chat API proxy
// This proxies requests to the 9router.ai OpenAI-compatible API

const API_BASE_URL = process.env.VITE_API_BASE_URL || 'http://168.110.203.28:20128/v1'
const API_KEY = process.env.VITE_API_KEY || 'sk-aaad468c2234563e-ol7kop-fce85c3b'

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Credentials', true)
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT')
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  )

  if (req.method === 'OPTIONS') {
    res.status(200).end()
    return
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    const { model, effort, messages, stream } = req.body

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Messages array is required' })
    }

    // Map effort to parameters if supported
    // Some providers support reasoning_effort parameter
    const extraParams = {}
    if (effort) {
      extraParams.reasoning_effort = effort
    }

    // Build the request payload for OpenAI-compatible API
    const payload = {
      model: model || 'gemini',
      messages: messages,
      stream: stream !== false,
      max_tokens: 4096,
      temperature: effort === 'low' ? 0.3 : effort === 'medium' ? 0.7 : 0.9,
      ...extraParams,
    }

    console.log(`Proxying to ${API_BASE_URL}/chat/completions with model: ${payload.model}`)

    // Make the request to the 9router.ai API
    const apiResponse = await fetch(`${API_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
      },
      body: JSON.stringify(payload),
    })

    if (!apiResponse.ok) {
      const errorBody = await apiResponse.text()
      console.error(`API error ${apiResponse.status}:`, errorBody)
      return res.status(apiResponse.status).json({
        error: `Upstream API error: ${apiResponse.status}`,
        details: errorBody,
      })
    }

    // Handle streaming response
    if (payload.stream) {
      // Set headers for streaming
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      res.setHeader('X-Accel-Buffering', 'no')

      // Pipe the response data to the client
      const reader = apiResponse.body.getReader()
      const decoder = new TextDecoder()

      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          res.write('data: [DONE]\n\n')
          res.end()
          break
        }

        const chunk = decoder.decode(value, { stream: true })
        res.write(chunk)
      }
    } else {
      // Non-streaming response
      const data = await apiResponse.json()
      return res.status(200).json(data)
    }
  } catch (error) {
    console.error('Proxy error:', error)
    return res.status(500).json({
      error: 'Internal server error',
      details: error.message,
    })
  }
}