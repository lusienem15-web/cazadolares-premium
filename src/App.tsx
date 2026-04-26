import { useEffect, useState } from 'react'

interface User {
  id: string
  isPremium: boolean
  subscriptionType?: string
}

const stripeUrls = {
  weekly: 'https://buy.stripe.com/test_fZu6oHdFM3pteHRbMz8N200',
  monthly: 'https://buy.stripe.com/test_cNi7sL1X4f8b9nx17V8N201',
  yearly: 'https://buy.stripe.com/test_4gM9AT318d0357heYL8N202'
}

function App() {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // Simular login do usuário
    const userId = localStorage.getItem('userId') || `user_${Date.now()}`
    localStorage.setItem('userId', userId)

    fetch(`/api/user-stats/${userId}`)
      .then(res => res.json())
      .then(data => {
        setUser({
          id: userId,
          isPremium: data.isPremium || false,
          subscriptionType: data.subscriptionType
        })
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  const handleBuyPremium = async (type: 'weekly' | 'monthly' | 'yearly') => {
    if (!user?.id) {
      alert('Faça login primeiro')
      return
    }

    const url = new URL(stripeUrls[type])
    url.searchParams.append('userId', user.id)
    url.searchParams.append('subscriptionType', type)
    window.open(url.toString(), '_blank')
  }

  if (loading) {
    return <div>Carregando...</div>
  }

  return (
    <div style={{ padding: '2rem', maxWidth: '1200px', margin: '0 auto', color: 'white' }}>
      <h1>Cazadólares Premium</h1>

      {user?.isPremium ? (
        <div style={{ background: 'rgba(255,255,255,0.1)', padding: '2rem', borderRadius: '10px', marginTop: '2rem' }}>
          <h2>✅ Conta Premium Ativa</h2>
          <p>Plano: {user.subscriptionType || 'Premium'}</p>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: '1rem', marginTop: '2rem' }}>
          <h2>Escolha seu plano Premium</h2>

          <button
            onClick={() => handleBuyPremium('weekly')}
            style={buttonStyle}
          >
            Semanal - $6.99
          </button>

          <button
            onClick={() => handleBuyPremium('monthly')}
            style={buttonStyle}
          >
            Mensal - $19.97
          </button>

          <button
            onClick={() => handleBuyPremium('yearly')}
            style={buttonStyle}
          >
            Anual - $147.00
          </button>
        </div>
      )}
    </div>
  )
}

const buttonStyle: React.CSSProperties = {
  padding: '1rem 2rem',
  fontSize: '1.2rem',
  background: '#4CAF50',
  color: 'white',
  border: 'none',
  borderRadius: '8px',
  cursor: 'pointer',
  fontWeight: 'bold'
}

export default App
