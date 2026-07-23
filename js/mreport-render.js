/**
 * mreport-render.js — 오피스 마켓 리포트 렌더 계층
 *
 * 페이지 구성 (S&I 1Q 2026 PDF 재현):
 *   1  표지                          2  목차(CONTENT)
 *   3  주요 내용 요약 (키포인트4 + 공실률 카드6)
 *   4  임대차 시장 요약 (권역별 비교 차트 + 키포인트3)
 *   5  매입매각 시장 요약 (스탯3 + 키포인트2)
 *   6~15  권역별 리뷰 ×5 (키워드/분석 + 계약사례/거래 상세)
 *   16 Appendix (소개/조사개요)      17 백커버
 *
 * 편집 바인딩: data-p="모델경로" 를 가진 contenteditable → collectModel() 이 DOM에서 회수
 * 테이블: data-tbl="regions.CBD.leases" + 행별 data-row
 */

import {
  MR_REGIONS, MR_REGION_LABEL, MR_REGION_SHORT,
  quarterLabel, deltaText, fmtRate,
} from './mreport-data.js?v=1.6.1';

// ═══ S&I 로고 (snilogo.png, 241×73, base64 임베드 — 별도 파일 불필요) ═══
const SI_LOGO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAPEAAABJCAYAAADsUsARAAAACXBIWXMAABYlAAAWJQFJUiTwAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAACoDSURBVHgB7X0JkB3FmeafWfXe69e3+tANCAFCIMsGGiQQYyNsbGPven3MwM7a6zHh3ZDBBnEEsePYmF3asRuOnQ3b2NgsNhNrezfC9oRlz3htFnswBjFgZMkIm0NCFkLobB19qO93VFXmfF8drddPr0U3SEKC+juq61VVVlZWVn75n5kpklJKKaWUUkoppZRSSimllFJKKaWUUkoppZRSSimllFJKMyIlJ4gs8vqlnJ+9AL/rpFNvlTGdFV+VxbW83iQDZlDqzCbZ4XWLGDkFtHr1andkZER96lOfcoeHh9WePXuctrY209jYaIeGhuzY2Ji/fft2u379el9SSukMJVdOGHWr1uZ/ahiyZb3Hl1xW8kqscl0pWSPalorzyq3illeIjInsKMkpoM7OzrrFixervXv3Nvu+r5qbm7Ou65rx8XHfWhsgyfill15aTkGc0plMM+LEjwP0TdKl+uuchQoAdYxzJZhqXdbKAiJWaZWzYrW1yokyV5osV4u1olSgTAgcD1uA88O+siVj7UtayXDeU9sBdu8q2VCM7hU73XKR4wKwet68eUu01k02CFYppeqU49Rjr7RIDqBVgoth3iwLCm6CgOD1gyAoo/S78XtXLgh2DJbLvd/5znd8pJt2GSrpxyLOYunSw5nMZVbMpVmrW3A6X52uDn0oCzSsyg9p5ZSuKW94QVJKaYY0I068UM53htBAXXHPVRLUAYt/hdOtgMnlCexUVb8QoiaBpFLJkRhrDuDUkNL6H4yVfUhwEKfHsSVcetoAWrRokVtfX+8CqMuxzcdz7sbNrY5SOYI4fKaqKBf6lLA4wLQxJupgrF2PNE+UHKeAS4PXXnstk7wuDk0A94uXdcVZgfr4D3jSWeio2qrTOSgF6wud16FAzAhOpSBOacY0LRBvlBXtg1Js3pvJv98q09Zo1Cptnboxay4CHOr8GTCsBErgiy24rT4r6qM4GilkbJcVv/SEueJXSpnSi35hfVHy9nLZ7E2V15o1azINDQ2u9bzV4LIXuZnMe3F6NkTnJuwzAGj0zBjAMSMGhu3EFpODaxcjYRtSzMvn8zshZj9x+eWXvwT9udDd3T1jHb5dMnZUFCUOzxeKAcdSJu6nAGZIKKGUklJKM6ZpgXhQpNnJ5Drws0tZvRj7PwM06pyQwSqwq5lLnQBLvVYh327ROILkugh5BVbZnkA5wwDwU2XJMuMpQZzL5XQWVDbmYgDy3QDrSmwdBGsVSCdRcj7eR8xaqfm4bz6Az+OzsH8Z13ZKJBm8TkMcuLxoM1VJgrD2wiLw+usS3VNK6bggflgu7WwQ1WG0/bAR9S40uEu0Ve0lZVzowGEjTFoeG6MTC9NqQqg+yn9snNaE/4/+9sJUFqYvBTCH7OgaZVRvjwT/uyjHp0wms7RYLL7LcZz3QAm/BLptffisYwHch2PPGvMsztYDoLMB1EacPydJT8L9FLHPQjnYYa3yfN+FUWw9fg9ISimdpnRcEDdIpjFw7XzqvBB93w1+2QGmlQtiKCakZDKInRi8OoRnRGRliZKZAJj7IE6REZ3nXb6SJeGjp0EA3VzsLgEgz8N2tvX9SeBNxGiAdwxnxwBe6pyNQkCLzJIYxGGa+D4CmLpyYMx56ByGIK4/IymIUzqNqSaIfy5d9a6YBuOoq4HD68WoK4CHDqNMRiqAqeM9AOrjXNlT8jAEwyEc/xFXfW3MkHaUAwt0FjJlO+zWHb6xFyKvBY5VZ2M/O5JTj3JnWHP/u9HmSFEWl7bKMpzacEz5Ymt0BuLvOwHTv4CVeXYteRfALFHix7Wb8aIlq/Xecrms4Waqgwl9KVD+xRjMi5J7qEeH4DemC/sLsko91r16dU/3+vWBpCJvSqchubVPum4+LzmwTYiV+ly06SZgN2crABxRIjaHbKwQWLMPum1vYPQfjCqXg0D1OQGk3qyTC2wwH9asBcigFWnrcd98Hd5tZVK+1m41Yko3yjqAZl2t4tH/q7HRjcW8zopuq4mvwIaX7OYS0Hn4wIHBZcuWWRqq7rrtNnjJFNR9qSNoq/RksvHZ+N0K/1MeD2R/lRqeUjotqSaIW3N6tlfW8LmaS4GuLvhfHFuh/yYEsXoPYOhZR9Y4vnjFemcLz5vh3jHu87IwaJIRJeVAyguzO3qLA26u3PYzNwBH93RnxqrGQPzPg1PSBfOqUdobLQ2/0CzOcTneggULzsPuIorRUgO8EIOj8hnzUwBxqL29vZ/H999/v123LuoYytb2wif1MPLoivOaBGRw63rkk4de3N43Z04HuP/hNCgkpdORaoK4hDYMITgH0Zh+1ly1HFnhLoFdSnna6J7AUd71w09X6Y47jv7cN9nK/Cu5CsdBvcrYPnC9drDMYcDfK4lT2g7XkhyHADKI9VLPva4AXyXF+vAwt6lcREgzjq0sNfJQMUFkd8DEHUkppdOUJoGYsRqbpcuFBehsWKRXQpRekBitJqezJbpFjNUPOkr1X1vesE1mSNfLBgJ+ANC+S2ZIjrXtEIUvRCfTIepYDywBHG8v4vBwrTzgCzae5xXxzr6ucT2xcAPADNWsAycWcGJJKaXTjbSklFJKZzRNAvGXpFsdltm6bKXJWDUH7p/GxDVUSTBEMQCi6OhgPyzJe+UUU6BUAC5JMfi1jE10VTXXuoD7O8DDPwZx/NLjBYZALx6ESN0rp2jkVUopzZSm8BPDcCuMWdRT6aYEP1q+gmWXMdSnlgAs3/h+CeLylIamGJiNdDNVnod+7A4NDWUgSucB4BzE5YxSNceBELQGFWSGxsdta2urpJTS6UhV4nS3jMpuGJttERrlMC6WajVvnGNkVJM16jIJOJLp1JIulw+gbJtRjgNJPHQl0dfLDSC9HttfVF4DgJsZFQad+t0A+JXYzq8OEGGege/3l4vFveVSaXj+/PmMn059xCmdlnQMJz4Cy/AsWGxdZUfBj8vHvVvZTnDjpodl5UIejsrGA3TgrDvJPlXfdYswTx9hFFYoVjNILNpCsuHIR4Z5WIZW1n3hC19o53lwX79oDKNELgT0z5Zo4IOuKUorNYLzPcZxivPmzUsBnNJpS5NA3B1G7G+2j6sVvdCJt6MRL4sHKUwiFXNwcLOPQe62OS3P4mg043Wt+4/i+evk+TE5ifT1r3/9AHYHbr/99lcA1n4OosC+vtLPyw34fAfLns1mV+HYMIwSFy7Wxvw1T+OehmoAkwuzAzDWbsT2exMEhw8cOJBGa6V02lJNndjXalyL6TVGH1GRr7V+irTh+J+s0VcANoXAkaFAuUOP+CtfdcQpZ0UPH5AB7wbZOqZODgj2YPstgLhCositSf1NwpGDIFjNAf5wh7FzmY2THKBf0/cLMbwXaRlr/Qp+7wCoT8ksJCml9HrpGGASbE+XdL+XI1u2ewNle7VVs8GRm+xEfPNE2vD+rFafpMV6XOSdWtkenbEPWeUNl0Rvm1fOD8L3XAKHD2fTkBNIEI//AB/uCEDXxDBOnHIYoHEMR1bqVoliQwMdKdGhMa56vHEc9PEqzu/Guafr6+uf3rhx4xj8w6llOqXTlmpy4gZpKhXcoeExI/sAgBfR+hma2DRVJl4EbheCaDtAkNNGrQJ0xow1C8uOe8QDsH/rrxx6TMyIJyW6a8ay0la6Vt5YGCNANlwsFve7Wr+A5zcBn5dIJDVMIhuL/yocuGuTyT4mz/ah1EFcO4hzm8C5X4HofagM6uzsTMXolE5rqgnid8kjY4K/xzMr/gjW5ELvZUuer46OOgwpad2liME6jqjF4VhiLRxdVMRxr6WtTKl9XkbtFOu86krjM+LL7rIM9MnrnP4moa985SuMxjq8du3aXwGlu/C7kyOPaoRQhu+ZFDwZqcQYa6blOGL82IaTT+D3Izi/df/+/ePr1q0rS0opneZ03PHEEFd7MpnMM0Al9E07pI2sBBLaEohUs6hklHEkcivOPsNAiyzAkwevbsf58+BXvhDdwhFH5ff+xqwYEDfYlC2VB34jfz7ULTObBue2227LlUolDitcAv7aRZG/ZkJ7tFxHT9lRgHk7fh7E+T/heDtO/gnH+wYHBzkfQTpqKaUzgo4L4g/IH3ogK/f8JreSk7z1AiQXAJBtCdIqQXvsnnYkWI1hOcbBHAkDrUKWXVZhpBUAo/QhXB8o57I7rimtH5EZ6swEMKgFAF4COflyBndMEbgxieI0I7A8P4t7n8N9P4coPgzuOwLuWytILaWUTlua1hxbMAVthcS5D9y1ALDMtcr+OzTzBuxnc87IqfKpQoIOnVIwZnOML2T0c9AJzIOKehcE2z7rjn331/5lY9fJsxuZ+HjW7DvuuIPhU9zeC+55naIGoDVn+chOFT6ZUBLMYY0ZV1rv9I3ZDxdU/+7du70YwDUJ7qx/TzdWXS53FY8hpUx+VwaYwFIOQ9uPNm/bZj/w0ItmSDpP3Oz8U7wOfOBt+XzegfrOcnHUGS312nWcWVGK0Fhn4gi3IzbS/bfj98voBI888MADRySlM5qmBeJrCxv3cf+IrPScjGrSVq5B6+wAqNsUZ9aJaWImy9rZhOOKsNfRHLIym9P4BJb5YKfkd47j9kOI3XT8bELKQ29tR8PsQqJPIFsXjdI5Xgz05ILQ060DRmXBZ3wEuvVr+rUhhVyOzDvx85MTwSQVxO4Jlvlc0Bj8g5/Pl33oCTqaAO9kkeru7lb9/f15ADgfznJibZONItRYHwvCRJHPm6oB37EHaV7CyQzeYRBSDN1nKYjPcJrRvNONovf1etptyJQZLCEZq99jtTQYK+9T4QhBOQ/sNgs5Opxj+ejkeBFVNuhkWh4b6szhnLc3k1evV117AGhPvM0bq59/9913N/i+T9H8YwDgxzkrJTsRG88ImwB4Ym4taymiQ4xXrcn1CUOWyEI3k7kLDXwzuGwj8t1+//33b5/q3aE/U5VY4MfzeFW5p8o4dwRv0TfWMzZy7h9Gda8UYUKwNUJlTggpGPMuGxgYOA/g/QTfJeO6C2l2L5XLTfSy4R23RJORKpYNfZCilOLi+Grw5Qux/yjSfB/3ckvVhzOYZgTiVbKhEP7w5PfcPZZbMRtcuR5t9Z1oB1lR4fQ7ouOGmwA1moRnMlX4mnXczC8K/2unA01/vNbzIapmIcZS72XIJN1JWUmix2pMkAeghfp3Bagn9hSN8fPCMOJLqfng7AfkOIQ0NNK1JOCteh5PFhkC+uCDD3prpAvSyRynLCdl6FPIgQFgWuLPQkHehf1ibBkVOc9Gca6M0g2bCL0FSio4Zr3RKNlBvzrScKz4XOaFLXwlSemMpDe0FlNzW/A49yPD+smykYxr3Qus8ZuNBEsAk06IypejVc0Bh7qISCOUquMXE9PYxKR7Vv9Pbey+p+TCDWOSMx+MQjj1DTfc4JbHxy9Bg/wc8rkY9zVMTGoXU8Xsln+P30NIsx6cCv5qex8bOX6HIibvS7gptnfiWjeuPQJr96/RSfz229/+9q4kT3D/2dAdswA5Od3CmItPPC+e4/pgYMxP6GOWk0x33XXXyuHh4XMcrT+Dt71SO04O75nxfH83Z/GEnv83KKMHr8JLkBroFQdzLkPoyNRb329F+vlhNUNPxptsjQd2pAA+g+kNgfjyA5tDjvljuaHUKb0ZyZbBqWyR0+1QkrTaFsCpPTUxHzXp2PYSu6QSOHK2jmJBGnURTCWhuXPnKk5ah0Y4i3NHqynM0PHpoXg7ZGjAUooLqKlkUvmJ5x7lyOTorWHkl1K5yvzGx8c5Qb0b+5rdGj7oZD8SD8Y4qcRgGmxN4LC0+rMuwjKg4/I4t7aKZjIpc15AgJdidam1tdUZHR1tAJBL0IlpOzBIz1lA2UGmAD7D6YSsiniDhFbd0uZyF/2sUuwYfWHYtKrMuP8ja1yuiTQfXf9qAHo14HwemlxHdfef6M8ZCRsn+fpNzdIyCNH9/3zxlltaxoNgmXbdS9FilwmHQVaAaWJ5FpHfgCMO4Ph+HA60tbXB7tNvwUVvwfEcNOhvUDdUsT85WQGCc3Xh3Htw37sA2HngyJvAkf8IjrwfDZ+649m41jKVdovz+5HH93HPiJxssvbj2P7cRq47CTsOgBJl+FuIFQdb29t/F6cst7S0yD333BO+5I033jg+a9as/vnz5++eyOvYif/CV4T1/xqJJlSgipODEWHAQqJBHf0zVJrxOMgmJHBy3dPT49TX1y9Ax7GQBkdw/EZktA8VP4R6Gw+t48Zcj98c300dfQTHv0S91uWz2Uso23AomXLdYZw/aD2vGbpTc7iuFuwQ2AaRZxHXn8D3OAJPQj88CakfP6YTAuKj7qB43aQ+4eTser2sLg9LodSQhdhr6N6QIkRrP+QcVQygQsPkTAQO3FfNlHiTs+DAjHcmlyQncqsZccyNqAMzlpqzcQyiAdOtYmG4OozGoSGCUowMKtdkkngZFxWtWsgEHBHFBpxY3XNI3yxTv3tIBDC5npxsspaSQ3tSPhu9BK11/eDO/QDVpIUzYn2XFMSbd7zsqSNDXCfYOCqMBspc6NdnnWvt4h0z1fegY6COTnWlLgQw4+yN4f1FSAMBgM9vPstGQ0NL/H4Au0sJx3heU2wzMTBWesiD9V3H98S5Zks9HioMvv84B64Ui8WT31GeYXSS3ZjH0qPZlX+prboCgu0HYQBbFlTB2Y3moC7h/B/wsQ+8z9/0iTtvvnmBzWY/gY+7Eh/yUzVcSTS4+Wg4/w0vtBU99mP33ntvoTLBmjVr6uFSeT+41UVoEP9ZolFMk+Ks42lrKcOXcPBtch7k+WUcL4+59UR9xSGb4wD9r9FBvHjffff9TXLtmdCwJZnRjP6MEX0TXmgxXXLVdZEPTYDo2cSsQac1cm1549/LFHTrrbcuRY+71MlkbkPZ3lthpHsSZehD0e4GwPq++c1vDssMCZx3MfSETsjj/xUvuAz1Q+7n4r0IOJuoGHhnvv9OuPb+jhPxQ9X48ZEjRxRVHVz7EJJ+OJfJXAOwL0GnRg5cjpfLmVBD4umEe8qe92/IadGx/ryiPieVC8d0BXBhAtanE6tF1IHuwW6gr6/vRz/4wQ8I6re1SvAmTJSnYcUNfZOFaHGGKSkTb1xzKfTsyhR6cPzxOUrKQ6OYMh47nKLWcdjI+fziBBebnCYsJPVObHRnTYoXr/Fs6t4nnQNz9lw2Zls1hNKwoaMDoxFrbGxsRo2ZojBX04DHvEmihejognIlcs2N4KV7sKfVnnHufTbi5DmAtBWdIST39uampqbcwYOMHwm/JSfrN7GtIYwJwEY7AXV1DmtlvQ8i/yFcJtdNDPjV/nRKC9TXOSPqAdzHQTNH4nqg+kNJpB3PrrvzzjtP+fRQpxudEHF6JnRdecPPsPvZo5mV8zRjqTn6iL1+fD3mLzQ0XaQjo5OUIXqh0czicRi8EFuXE8I5AnME3OEAuMn+4tjYMUCG64dGuF+Do22BeEcl7fx4iCJ9qG4Fd2+Mxeu1ceY138NGriY2xm8zZFNOMuEZHYpLz1DErPSHW8vQ1T3gwoPf/e53ZyRqHjp0qGX58uVtRutbkOcHYMKeizzzXrn8QyBxBD3o99CbjYAVX2YgDuMZXwTHzOXq6v4a9fdqoVBohd79PJ77C3Bz1sEhitBx+fLMC/X0KmdgQWF/inOjEJ8bCOJZ7e3bxwYGCuWoDsn1QztFKFpHMexb8ONJPPtJZczy0H1JzwTdadbewbT1udweiO/Uzx+RtzHVBPHjstotyD6nUZqaPdHNANkQanioSzb76k0SXSjVVQ4jnCoN9xTxpkrD4YXg7D3UvWw06L8BeZ4znUgvUsXzD+OOwzgepegoJ5m0MVx2xokDN46eh48agDO5XG7G34WiLrY5kF5abDTG2g9BqNRePKEPAB5EB1py2FGocKomstwmAK4DdVeHD3IOtsNw/2W5JCzqMlw2p6ryd0lUTxynXURbqoulFyO5XLjaj1QMMJNIBO9HPruRdy8MlWPIt0/RqKHUIerJsReBEgM9GY68ZrDgW5tqz+whIw25utmtvvFWouVciY/4/31fv7hOLoZIs/Xku1EqtrA8vq9crR01hfgfN2ztsE3DhXK8vMGRKRr+P3Dk+bDEFHEjfa2f4bVagRzVFOtuY3B3PYrDvqHBwZchxp70SQNg6c3oyPg26f3QwD0UvDzT1ssOD6Loebj3Grz/UuQzD53RAdRBAcD5O0grPX97771FSq9IvuuWW26ZhY7iEtx3NvzmFxD8uHATrjUsWLDgIRq8aCMAuAMVGw5VNIH/99AzbALLfgXi+yQJCV6AkhPNolKno46Jv3tRpqeg9vwI9x2Gjk9R+hVevGPtWnomDudo24BYD736/ZC+xmHv+CGMa7Y6/7cL1QIFa7PF+MFZyshZUMQWWqOXlhzpapDcvMflklZyanmd9LRclX9UVlCnaVTHF+cL8cZILTYkWrxrfiQV9cacfpaNPL9s2bLX1PXJkXEfdb69lmOJAUg1jRFQIFp/C0jLePJ9BDBcNyedA+jIrxvE0WETFFry0XEBWDMyUn7pS18ic0ss3fkoMztOfRhWYx9isq2hSlBP5TcBzk3oosazs8rz2mhRjgGfEMvJcJOiQ8vyVMFr0T224p4CJIEivjm3ajcSRXauq+VFxQ2nJG6h5AU31yk30p4udMwyLnALOdYZX2453as4K2BNWmG0vQ5yznhDLv9lWI+26eKup+V1Dugfy3hLHe2e5RrFsL8mn4uZVjqYos0z9DNaORSegxFE6CsEl4isIMdghi6gRrDJBfjqw/igz79WOWKO/HNwgy1A/MuO634Mje3jjMiytWe/DHfgwNT7qIf9BFvpVE0cELAOyOmqJsxn7DnYMQdAaBqqplp3qpIS3y6s9Wfjva7C+3SENgGIsFQR0CN4smePqURFQ0NDGRLRTonaTCHuOPO4fy7qnSOnGJvtw5dPAyOlmgLDXulh+NrXvna8BQbo8gsqPAP70Lv0oHM81NvbW1m3HC73oqWobe1HY3vAMvrIFy5c6ADIYUcvb0OaBOINclWdkVJb1jqLUFFcKbAjMTRxHCFA9G7H6nP83Oz6x4LOAj7qS41SV3xBNoQGlSVxjwr5h8N9wjawHXvO7TMiq1tKUmrFpSttYC+E4jR7KqOvpTVTyS4IYwSawIDiwXVxBCLXMMpQlDh6quKWZHTUedAPOSP8hs9+9rPOyMjI+BTjg8O+ApZZHbqOtI4GB0yDKEqjXsYA9rG4czlVRA44ELttKstDgxD1xFx/fz+t+dO2lFMFkWhxOhUf0+bhMdKrvkZ6VJYPA5eJDMRRT2e52JxSGfipHXGO1WQ4I7BMn2xYhkzGn93eHlrcJ13E8+M6Txz8rp2uMeMtTJMabqkh1+IEhSVOoOHH1e+DsiVByJ+lAYBqwCf6S0o/UB27lFbjjpv5ekHZwbktV7/crDK2qXck5AI5yYYVOyJjeon4qiizlMmMLs6IuliJ/iTyu9pULCxeSdHgCVXG9WfQn3P94JAT4+syKqoXB6MMJIjDICW+7sQ9eRfKeL40Nf2ymQubo0ennlSlKzHg39myZYuGGMyAgxwsnLSYZhKduBZVWE4IJEaF9dcQ904a4ZkMYNlNQ1r8rlHYqLUMojBgxQ2O5xHo0wZx3IFxCcqwLjmzJ84VSlBfeqpUhOHhYdtQV1dmQI1QpI97EtY97qvnORsZppIxzNEANn/6AlvspvIYQrrl4ou9dffcYyAyVV5ndFqip/Pdc+jY6VpT2OTtSpPFaX+0RYxeAi7ZfozjnUFBYWiCZUDGudh5QM5f4UyxYdDbGUg5GM24A2xWQLlPU0xW18HiqfIl67W44s7VVs0NlD07DrGcxIYTJda3Bi4H+CTBTZ1YJ67r6yv6c+fughFjET7iXkURriJQo8Ll0ol/zbj3RpwcbW1t3Tg4OFiCAScUy8E9aUHNDg0NdcAY02iD4AKUdS5E6aUmXgliqo49Oa+jEVR8xkeCcnkMef8MHMPAAHNSfcUo+wDebwcXRqfxSKIqo+VoLiqyGeWfA7mUdfqa44M56AFbgLrh5PscxcWhms1QdOm+KtKQuH379kkVgQ5LG1qF0VlIFDEXTboP/RXlOYxvwwitend6doVKCqc95g8duZoYqVXf9Mwz9d1bt5a6Iz8zieVpxb9OSUaukU9Yi89QNnPnzn3bcuRJIMZXajaiL8S3aa+0Nhzd2/gmvTjWXS8M71NqF8DrQYl6Vdj7Ki5xrGhNbcYds4RD5kTlHK59VIP7hnnEgyTKygwJx+X6ZkMx5uj3rltX7F69evfg8uW7wS6oX5ETz7NVgxkA0NlkEL4xN0gU3cNoITbUreEzotUeeO58gHcOGuR12OrDQRXQhY/HiSfKqfXZoQ6p1Edw2IcG9EhoIT7JAR/333//AFw5gwvmzRuSaHhlEoQSjUqCtVhF4uz2aWRHEFv4dsm++lF5Z0VTNiguoOdDOlHxLJ8TFdzY2AhvUJkBMPUqisDSUfisFHFPL4DcydhooZtvZkDWE24z6tlKNYDD1jeVSvWj0Qc5qhejs9EEMT0QUXmHWd5FixYZ6PgpiEk65++C7PszwOEwuG4/PJNUcy+IAaYS5TKIv23yqeCG6sDnDMBp6+NRNQFXW0MyDjbIALjQta3jSRQMXVnbzDtanU1GyQfRGh+AhHTkWWkqXywT08Xae9avD+5cunSHyud/hGTX49wsxjireBUHO3mgPi2uBnIeQwE9gPSa5Hm05OJfCxJlYaSaxQXEKzlw7BapFQIY7uNnMATzUmxD2WhoJF0g62SyZ+yEE/X7tWvXPstGDs54BZ5/Hjg0TfeoN/tvkWTo85///EGU0a8cTpnQTTfdVAeANuLeMHYZ6Rho8VQs2SzEO56roki2c2CdzqHT2MOBBtg7eA5DL5ex89SRKkOj1RDKshf1uCWfybwDnee8aj/2dCn+BuwkzsGPxehcF4+Pj9MDMNbV1ZVZtWqVxrmuAMYsVH42vu0FPImW7+z8pqY61M1HVLRiZjEcxdXRsQliib+uu/stPWvpJBAfHC0NzRL9nOPoRghmTWgYzcDY+U40tU7FxHjJPiIdxseGQJ8Y6RMK3ipKqyQRx48lJ07rRQuXg5mbJ5QEEKMmj7BhVv+pubkf3GCTRDNTjDBMUFUsxVIBxIb4tovDZVnig1CHjBKEZU+GJlZFf9WM7qx6RgYg4IoTDHq4Bufa0NB/ggZfWS0nmsJ8Uead5IbomBhxxk4lmRThEtoOgE8YDEOpYFd1BuBYbl9fXxPKThBwYAPjm3fQKhxbe8MZWZBHO9KUYfXdTxDDZacgemc4kQDfGWBy4uAbTkBw5Fvf+lbPXWvXLhKlXlcYr4km+Ge9s1xhSCXYc2cmk2HYpSxfvpydiItOeb7iZI0xiPH8HnYkKBvbcTMkvauFng0OgnGcPU6x+NysujAq8+0D4hvkRn+d/LjQGTQ9bzLlQ9a4L+L0Y+C8V7LyAIeFqLrcVGJ2LWE0SVMJi8pgZF/Zg+DkJaD3+3AtjGX93I5xOHJqZMXJ4qkj98KI8St8YA6Cfzf0OA4hpCjXUg3I4+m4E2WpmlQA6ffRcIUDzl6yEyj5NAMbJBpvrKrAzE5kGX7Nho79X26//fZnvvGNbzzEC2VB9ck8RYlET2GFT8ZZz5BewjMPGd+fjcY6ivdOJvafY6MhiXfjt3/n7bfvM5HOSkA7QFduYGCgDkCgJXvYMpzS2o0A7CbU4e9sNFprOdI2grMyHHVkcGBg/R233VYASOaE0ovIZaFkRWnE2p3owL6DXiUcfmqgj0Ml0bAvJAavMMIOPcJrvY9JfN+UklQ0J9gVYKezOJgFLkC+LztMdixL2WF6nheCG+/yJMrQj/JciWttUCnew/hutKNxvO+fsoXCRlUsMlhkl7yFaVINq2jeZ/Za+7s96Vkllx5wM9nthqKr2FbIbZwSJlcN1mrOPBUlTVZVbDBpjqCTGAVY/tlo1fceebJ3qvtjK/PIpz/96Rfht3wVoiGHsS1FmZrJVasjrqbrfVAVK0KgAQ2EQDbmCeT5DH5fTX82GklTpRsq4ci4ZwGfj+N/JVE/9tCIbLY5WZi8s7JTsKiJOgDQ7THRirXpoosu2r9t27ZD4EwMUGkBaC5EORmGGA6XBHI+yCzxHgyMIEAoblKHZXBNNoxnBgcTDixQautXv/rV3RBDGRK5EDL2Yuq12pg/s7HmFHPr87BnMAeNekk9M0ztUQB3MD4XuQhkUsfIgJLXei87YW2ObnTBlRfhmVyKkkEknLXzHXgvcuE5LIcfxUvT//QK0h1C3X4EHVE76uICiSzc7LiY5xxIbm953/FU3aTtxr+HZW5/vTc8UsgG34G37/+imS035HgmgFGHPbNaTIMVGmmST/zBkgapbGTnCt0PluI4PnQfg+tx/Dw+zE6cfgotpS/j12+TaVIxIg8WyX/Eg58KfP8K+CjPxQd9H7ki9vzwZAnaTmb8SWMxsQuEBWWA/wEcvoAW9zzE+xfxjj34+D1tbW0FWLL/B9K14fqXbTRIPbQeVXF8di4MXlkFQHzx55634fMPPPC7fTK/hCeOoBpogMlKlWBSFEOpBppLGJc8LZGPKzRCXw3AVX8NaeS3htFmsLCbIPiIjVaHZBSTjeOiOdCjIX6gjjneoGJcssg2pA+t9ugMOS3R75CY0wydg9s5/S0NgCttZKhivDN1D66SsQff7YfKdXtdSENwPYXl5pjhcDx1EHBWEW6M/hrPzsyXTmMkAejhORz5dI5EhrsGGr2QJxfQK4ED/y9y4MGRkW0457U2Nm6B+NwZ0P0FfVgYfWftQc0hmlFn9pam48k69sPyS1ZoCc3rJZ54NLsSznaKlZa6Bxgoe2br2CRY4KinKAGzjXv0xJ5FA8woLg/hyitsgPjuz35Qnj8sM6B4VgduYejjHbfeWm842BzGJokaX7MkTDDS3aK1mOIQv1DspLTH2EFyGhP6o3cBDM8FpdKWrz/44MSkeTfffPOfIMbnABICdSLQINlXgJn+1nngHEvRoF4u8bqxAa3kJopu81RyT1w/vphsZAewoXwq06CKiKy98QD+xejEhlCX10k0aUKDRPk7kySRCMAsBxs6RxUNagbOSGh53tvf309GukuiIZ8rJRpSGA7FjEwbtoy6YlDPQYjQm/DMsfvuu2/COQsAh5yb4izZMg2K1NFnyAZNPH44CS9tUBwwEZXbhh0DJwIMghfQk9JPX+TEhHfddhuXrK03kYjAiLEkZLeUy2Te8vHUM4qBdsr5rbJI3KA3CPUgx1dNGhKab713gBs7GW1mBTY0tGTw1SEdw8gQqBIHvPva9juu7qvznbFAl8rjbrakhgulIfHfsLiz/9Ch38Ml8hw+/EPZIKhT2ew5QWRBPYvRWABgyJ2gwDJs01NBMGxdd1S77h5yDa9cLoIbFVvb29moJ310cPu+9evX68suu+xf8xjpM1OVg1O0syGVgmDst11ddvFO84+2lH0kZ8uwiOePqWvf+mHnAqUg6sT6ZCZENxEHEfwGNoIs1It/4kkdBAvCzjSTaYUKYMBhQ86YaWjg4nPlplxujMe4x5szZ07oh7/nnnvCTvFzn/vc99ocJzes1AO5XE5Qb2epaKbMYRuueBvGmnPesWNKConlOeS3rVQqrSt5XgM6vsAWCqas9XH91qE1m9JNJIIfwPfZiHOP5rLZR9ExtKOs3MY1Z23JZA7h4Vx9M3w+Acx988GDW6Sh4aXRjo6VELXDOiVXbj14cMeWt8FyPK/DrnKUHpYP5fJSUMYtXQb7IjBqOowQuwRxaGkuB8YWcTzsOcFh05A5PHvAL1yeTONzkujWW289N7ZcL44ju5rjaKBCGLbneYOMfEJD37F06VIfjXfa5VmzZs2UIOY0NWjMDoM/0JjN/O3b7cXrIzdZp/ROWderZXXIXdUM16KqRXAxEXgaojbH/1rUAyOcvFJd3ZGgrq70YHd39bDJyHlQQR/60IdyAKQCh17EekRncIRuKxjtDh3n0eFUuuzwlixZojiqiCfZQajJAyMmCB3QQhqnyG3R2c6lpRws/Ck86xeov1+gI2BMdyeOGeZaRjkOVwXVTKhJjAdH3beic9K4L8POC771fnkb0BsCcUopvRGqAWK6zzYC8T9Fh/FTSWla9CZMz5NSSimdSEpBnNKbRtEgZuEsmvAOuZzRUocjotJ2OSM65XNspZRSFdETQPcbpxemzk09tiApTZtSEKf0plF9e/vBQn//J8YLBRqjOCy0nM/nS7CMv33HFb4OSsWWlN5sKjU3N3P4Y5GBIwAwPQUnfc6ylFJKKaWUUkoppZRSSimllFJKKaWUUkoppZRSSimllFJKKaWUUjpT6V8AsUIXH7uUg+QAAAAASUVORK5CYII=';
const logoImg = (h, white = false) =>
  `<img src="${SI_LOGO}" alt="S&I Corp." style="height:${h};vertical-align:middle;${white ? 'filter:brightness(0) invert(1);' : ''}">`;

// ═══ 문의(QR) 설정 — 원본 PDF p16 링크 기반, 분기별 utm_medium 자동 ═══
const CONTACT_BASE = 'https://sni.recatch.cc/workflows/ryuglrmmsb';
export function contactUrl(quarter, team) {   // quarter '2026Q1' → utm_medium '오피스마켓리포트261Q'
  const medium = `오피스마켓리포트${quarter.slice(2, 4)}${quarter.slice(5)}Q`;
  const p = new URLSearchParams({ utm_source: '브로셔', utm_medium: medium, utm_content: `문의하기_${team}` });
  return `${CONTACT_BASE}?${p.toString()}`;
}

const $ = (sel, root = document) => root.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const nl2br = s => esc(s).replace(/\n/g, '<br>');

let _chart = null;

/* ═══════════════ 페이지 조립 ═══════════════ */

export function renderReport(model) {
  const el = $('#mrPages');
  const q = model.quarter, prevQ = model.prevQuarter;
  const year = q.slice(0, 4);
  const qKey = q.slice(4);              // 'Q1' — Appendix 조사기간 매핑 키
  const qLabel = `${q.slice(5)}Q`;      // '1Q' — 표지 표기 (PDF 동일)

  el.innerHTML = [
    pageCover(qLabel, year),
    pageToc(),
    pageSummary(model),
    pageLease(model, q, prevQ),
    pageDeal(model),
    ...MR_REGIONS.flatMap(r => [pageRegionA(model, r), pageRegionB(model, r, q)]),
    pageAppendix(model, year, qKey),
    pageBackCover(),
  ].join('');

  renderLeaseChart(model);
  bindTableButtons(model);
  renderContactQRs();
}

/* ── 1. 표지 ── */
function pageCover(qLabel, year) {
  // 원본 PDF 표지를 그대로 사용 (제목 텍스트 영역만 배경색으로 소거된 이미지)
  // → 실선 패턴·로고·SPACE&INNOVATION 모두 원본과 동일. 제목만 HTML 오버레이(분기 동적).
  // 좌표는 이미지 소거 영역과 정합 (x 49.9%, y 34.6% — object-fit:fill 로 비율 고정)
  return `
  <div class="mr-page cover" style="isolation:isolate">
    <img src="./mreport-cover-bg.jpg" alt="" onerror="this.remove()"
         style="position:absolute;inset:0;width:100%;height:100%;object-fit:fill">
    <div class="cover-title" style="left:54.3%;top:37.6%">
      <div class="period" contenteditable="true" data-p="_coverPeriod"
           style="font-size:7.2mm;line-height:1.2;margin-bottom:1.2mm">${qLabel} ${year}</div>
      <h1 style="font-size:8.7mm;line-height:1.135;letter-spacing:-0.2mm">OFFICE MARKET<br>REPORT</h1>
    </div>
  </div>`;
}

/* ── 2. 목차 ── */
function pageToc() {
  return `
  <div class="mr-page toc" style="isolation:isolate">
    <img src="./mreport-toc-bg.jpg" alt="" class="page-art art-toc" onerror="this.remove()"
         style="position:absolute;left:0;right:0;bottom:0;width:100%;z-index:-1;pointer-events:none;-webkit-mask-image:linear-gradient(to bottom,transparent,#000 10%);mask-image:linear-gradient(to bottom,transparent,#000 10%)">
    <div class="toc-head"><div class="toc-badge">C</div><div class="word">O N T E N T</div></div>
    <div class="toc-list">
      <div class="toc-part"><div class="pageno">03</div><div>
        <div class="part-title"><b>Part 01.</b>시장 동향</div>
        <ol><li data-n="1">주요 내용 요약</li><li data-n="2">임대차 시장 요약</li><li data-n="3">매입매각 시장 요약</li></ol>
      </div></div>
      <div class="toc-part"><div class="pageno">06</div><div>
        <div class="part-title"><b>Part 02.</b>권역별 리뷰</div>
        <ol><li data-n="1">CBD (도심 권역)</li><li data-n="2">GBD (강남 권역)</li><li data-n="3">YBD (여의도 권역)</li><li data-n="4">BBD (분당·판교 권역)</li><li data-n="5">기타 권역</li></ol>
      </div></div>
      <div class="toc-part"><div class="pageno">16</div><div>
        <div class="part-title"><b>Appendix.</b>S&amp;I Corp. 소개 &amp; 조사 개요</div>
      </div></div>
    </div>
  </div>`;
}

/* ── 공통 조각 ── */
const secHeader = (no, noLabel, title, sub = '') => `
  <div class="sec-header">
    <div class="no-block"><b>${no}</b><span>${noLabel}</span></div>
    <h2>${title}${sub ? `<small>${esc(sub)}</small>` : ''}</h2>
    <div class="si-mark">${logoImg('22px')}</div>
  </div>`;
const checkDivider = `<div class="check-divider"><div class="dot">✓</div></div>`;

const kpRow = (i, p, path, pink = false) => `
  <div class="kp-row ${pink ? 'pink' : ''}">
    <div class="kp-badge">${String(i + 1).padStart(2, '0')}</div>
    <div class="kp-title" contenteditable="true" data-p="${path}[${i}].title">${nl2br(p.title)}</div>
    <div class="kp-body"  contenteditable="true" data-p="${path}[${i}].body">${nl2br(p.body)}</div>
  </div>`;

/* ── 3. 주요 내용 요약 ── */
function pageSummary(model) {
  const v = model.vacancy;
  const q = model.quarter, prevQ = model.prevQuarter;
  const warn = !v.auto
    ? `<span class="warn-badge">⚠ 확정 통계 없음 — 수치를 직접 입력하세요</span>`
    : (v.statsStatus !== 'finalized' ? `<span class="warn-badge">⚠ ${quarterLabel(q)} 세션이 작업중(draft) 상태입니다</span>` : '');

  const card = (label, cur, prev, total = false, idx = -1) => {
    const d = deltaText(cur, prev);
    const pathBase = idx < 0 ? 'vacancy.total' : `vacancy.regions.${MR_REGIONS[idx]}`;
    const subLine = d.text
      ? `전분기 대비 ${d.abs}% ${d.dir==='up'?'상승':d.dir==='flat'?'보합':'하락'}`
      : '전분기 대비 –';
    return `
    <div class="stat-card ${total ? 'total' : ''}">
      ${v.auto ? '<span class="auto-badge edit-only">자동</span>' : ''}
      <div class="row1"><span>${label}</span><span class="delta ${d.dir || ''}">${d.arrow} ${esc(d.text)}</span></div>
      <div class="value" contenteditable="true" data-p="${pathBase}.cur" data-num="1">${fmtRate(cur) || '–'}</div>
      <div class="sub">${subLine}<br>
        (${quarterLabel(prevQ)} <span contenteditable="true" data-p="${pathBase}.prev" data-num="1">${fmtRate(prev) || '–'}</span> → ${quarterLabel(q)} ${fmtRate(cur) || '–'})</div>
    </div>`;
  };

  return `
  <div class="mr-page">
    ${secHeader('01', '시장 동향', '주요 내용 요약')}
    <div class="center-title">${quarterLabel(q,'kr')} 서울 오피스 시장 주요 동향 ${warn}</div>
    ${model.keypoints.map((p, i) => kpRow(i, p, 'keypoints', true)).join('')}
    ${checkDivider}
    <div class="center-title">서울 전체 오피스 시장 공실률 추이</div>
    <div class="stat-grid">
      ${card('전체 공실률', v.total.cur, v.total.prev, true)}
      ${MR_REGIONS.map((r, i) => card(`${MR_REGION_SHORT[r]} 공실률`, v.regions[r].cur, v.regions[r].prev, false, i)).join('')}
    </div>
  </div>`;
}

/* ── 4. 임대차 시장 요약 ── */
function pageLease(model, q, prevQ) {
  return `
  <div class="mr-page">
    ${secHeader('01', '시장 동향', '임대차 시장 요약')}
    <div class="center-title">임대차 시장 (Lease Market)</div>
    ${checkDivider}
    <div class="center-title" style="font-size:15px">권역별 공실률 비교 (${quarterLabel(prevQ,'kr')} → ${quarterLabel(q,'kr')}, 단위: %)</div>
    <div class="chart-box"><canvas id="mrLeaseChart"></canvas></div>
    ${model.leasePoints.map((p, i) => kpRow(i, p, 'leasePoints')).join('')}
  </div>`;
}

function renderLeaseChart(model) {
  const cv = $('#mrLeaseChart');
  if (!cv || typeof Chart === 'undefined') return;
  if (_chart) { _chart.destroy(); _chart = null; }

  const v = model.vacancy;
  const labels = [...MR_REGIONS.map(r => r === 'Others' ? 'Others' : r), 'ALL'];
  const prevData = [...MR_REGIONS.map(r => v.regions[r].prev), v.total.prev];
  const curData  = [...MR_REGIONS.map(r => v.regions[r].cur),  v.total.cur];

  _chart = new Chart(cv, {
    type: 'bar',
    // 발행물(PDF/PPTX) 전제: 수치를 막대 위에 상시 표시 (chartjs-plugin-datalabels)
    plugins: typeof ChartDataLabels !== 'undefined' ? [ChartDataLabels] : [],
    data: {
      labels,
      datasets: [
        { label: quarterLabel(model.prevQuarter), data: prevData, backgroundColor: '#c3cdd9' },
        { label: quarterLabel(model.quarter),     data: curData,  backgroundColor: '#2e4057' },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      events: [],                                    // 호버/툴팁 등 인터랙션 전면 제거 (인쇄물 전용)
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } },
        tooltip: { enabled: false },
        datalabels: {
          anchor: 'end', align: 'end', clamp: true,
          font: { size: 9, weight: 700 },
          color: ctx => ctx.datasetIndex === 0 ? '#8a94a3' : '#2e4057',
          formatter: v => (v == null ? '' : (+v).toFixed(2).replace(/\.?0+$/, '')),
        },
      },
      scales: {
        y: { beginAtZero: true, grace: '12%', ticks: { font: { size: 10 } } },   // grace: 라벨 잘림 방지 여유
        x: { ticks: { font: { size: 11, weight: 700 } }, grid: { display: false } },
      },
    },
  });
}

/* ── 5. 매입매각 시장 요약 ── */
function pageDeal(model) {
  const stat = (s, i) => `
    <div class="kw-card">
      <div class="big"   contenteditable="true" data-p="dealStats[${i}].value">${nl2br(s.value)}</div>
      <div class="label" contenteditable="true" data-p="dealStats[${i}].label">${nl2br(s.label)}</div>
      <div class="sub"   contenteditable="true" data-p="dealStats[${i}].sub">${nl2br(s.sub)}</div>
    </div>`;
  return `
  <div class="mr-page">
    ${secHeader('01', '시장 동향', '매입매각 시장 요약')}
    <div class="center-title">매입매각 시장 (Deal Market)</div>
    ${checkDivider}
    <div class="deal-stat-grid">${model.dealStats.map(stat).join('')}</div>
    ${model.dealPoints.map((p, i) => kpRow(i, p, 'dealPoints')).join('')}
    <p class="edit-only" style="font-size:11px;color:#999;margin-top:4mm">
      💡 매입매각 데이터는 아직 DB화되지 않아 직접 입력합니다. 카드/문단을 클릭해 편집하세요.</p>
  </div>`;
}

/* ── 6~15. 권역별 A(키워드&분석) ── */
function pageRegionA(model, r) {
  const b = model.regions[r];
  const kw = (k, i) => `
    <div class="kw-card">
      <div class="big"   contenteditable="true" data-p="regions.${r}.keywords[${i}].big">${nl2br(k.big)}</div>
      <div class="label" contenteditable="true" data-p="regions.${r}.keywords[${i}].label">${nl2br(k.label)}</div>
      <div class="sub"   contenteditable="true" data-p="regions.${r}.keywords[${i}].sub">${nl2br(k.sub)}</div>
    </div>`;
  const sub = r === 'Others' ? '(마포·공덕·DMC·잠실·송파·구로·가산·용산·마곡·영등포)' : '';
  return `
  <div class="mr-page">
    ${secHeader('02', '권역별 리뷰', MR_REGION_LABEL[r], sub)}
    <div class="center-title">권역별 키워드 &amp; 시장 분석</div>
    <div class="kw-grid">${b.keywords.map(kw).join('')}</div>
    ${b.points.map((p, i) => kpRow(i, p, `regions.${r}.points`)).join('')}
  </div>`;
}

/* ── 권역별 B(계약사례·거래 상세) ── */
function pageRegionB(model, r, q) {
  const b = model.regions[r];
  const qTag = `${b.leases.length}건 · ${q.slice(0,4)} ${q.slice(4)}`;

  const leaseRows = b.leases.map((l, i) => `
    <tr data-row="${i}">
      <td contenteditable="true" data-c="subRegion">${esc(l.subRegion)}</td>
      <td class="b" contenteditable="true" data-c="building">${esc(l.building)}</td>
      <td contenteditable="true" data-c="areaPy">${esc(l.areaPy)}</td>
      <td contenteditable="true" data-c="tenant">${esc(l.tenant)}</td>
      <td class="edit-only"><button class="row-del" data-del>✕</button></td>
    </tr>`).join('');

  const dealRows = b.deals.map((d, i) => `
    <tr data-row="${i}">
      <td class="b" contenteditable="true" data-c="asset">${esc(d.asset)}</td>
      <td contenteditable="true" data-c="price">${esc(d.price)}</td>
      <td contenteditable="true" data-c="pricePy">${esc(d.pricePy)}</td>
      <td contenteditable="true" data-c="sellerBuyer">${esc(d.sellerBuyer)}</td>
      <td class="edit-only"><button class="row-del" data-del>✕</button></td>
    </tr>`).join('');

  const insight = (key, obj) => `
    <div class="insight-box">
      <h4>주요 ${key === 'leaseInsight' ? '임대차' : '매입매각'} 인사이트</h4>
      <div class="ins-title" contenteditable="true" data-p="regions.${r}.${key}.title">${nl2br(obj.title)}</div>
      <div class="ins-body"  contenteditable="true" data-p="regions.${r}.${key}.body">${nl2br(obj.body)}</div>
    </div>`;

  return `
  <div class="mr-page">
    ${secHeader('02', '권역별 리뷰', MR_REGION_LABEL[r])}
    <div class="mr-table-wrap">
      <div class="mr-table-title">주요 임대차 계약 사례 <span class="meta">${qTag}</span></div>
      <table class="mr-table" data-tbl="regions.${r}.leases">
        <thead><tr><th style="width:18%">세부권역</th><th style="width:32%">빌딩명</th><th style="width:24%">임대면적</th><th style="width:22%">임차인</th><th class="edit-only" style="width:4%"></th></tr></thead>
        <tbody>${leaseRows}</tbody>
      </table>
      <button class="tbl-add-btn" data-add="lease" data-region="${r}">＋ 계약 사례 행 추가</button>
    </div>
    ${insight('leaseInsight', b.leaseInsight)}
    <div class="mr-table-wrap">
      <div class="mr-table-title">주요 매입매각 거래 <span class="meta">단위: 억원 · 만원(평당)</span></div>
      <table class="mr-table" data-tbl="regions.${r}.deals">
        <thead><tr><th style="width:32%">자산명</th><th style="width:16%">매매가(억원)</th><th style="width:16%">평당가(만원)</th><th style="width:32%">매도→매수</th><th class="edit-only" style="width:4%"></th></tr></thead>
        <tbody>${dealRows}</tbody>
      </table>
      <button class="tbl-add-btn" data-add="deal" data-region="${r}">＋ 매입매각 행 추가 (수동 입력)</button>
    </div>
    ${insight('dealInsight', b.dealInsight)}
  </div>`;
}

/* ── 16. Appendix ── */
function pageAppendix(model, year, qKey) {
  const q = model.quarter;
  const qMonths = { Q1:['1월 1일','3월 31일'], Q2:['4월 1일','6월 30일'], Q3:['7월 1일','9월 30일'], Q4:['10월 1일','12월 31일'] }[qKey] || ['1월 1일','3월 31일'];   // 방어적 폴백
  return `
  <div class="mr-page apx" style="isolation:isolate">
    <img src="./mreport-back-bg.jpg" alt="" class="page-art art-apx" onerror="this.remove()"
         style="position:absolute;right:0;bottom:0;width:58%;height:64%;object-fit:cover;object-position:right bottom;opacity:.14;z-index:-1;pointer-events:none;-webkit-mask-image:linear-gradient(to left,#000 85%,transparent);mask-image:linear-gradient(to left,#000 85%,transparent)">
    ${secHeader('03', 'APPENDIX', 'S&amp;I Corp. 소개 / 조사 개요')}
    <div class="center-title">S&amp;I Corp. 소개</div>
    <div class="apx-card">
      <h3>${logoImg('26px')}<small>Commercial Real Estate Advisory</small></h3>
      <p>에스앤아이 코퍼레이션은 서울 오피스 임대차 자문(TR · LR), 매입매각 자문, 자산관리 및 시장 조사를
      종합적으로 제공하는 상업용 부동산 전문 회사입니다. CRE1 팀과 CRE2 팀이 임대차와 매입매각
      전 과정의 자문 서비스를 수행하고 있습니다.</p>
      <p style="margin-top:2.5mm;font-size:11.5px">홈페이지&nbsp;&nbsp;<b style="text-decoration:underline">www.sni.co.kr</b></p>
    </div>
    ${checkDivider}
    <div class="center-title">조사 개요</div>
    <div class="apx-2col">
      <div>
        <div class="apx-h">조사 대상</div>
        <ul class="apx-list">
          <li>서울 및 분당 소재 연면적 33,058㎡(약 10,000평) 이상의 Prime · A급 오피스 빌딩</li>
          <li>주 용도가 업무용인 빌딩에 한정 (오피스텔 및 층별 분양빌딩은 제외)</li>
          <li>리모델링·신축 진행 중인 미완공 자산은 표본에서 제외</li>
        </ul>
        <div class="apx-h">조사 기간</div>
        <ul class="apx-list"><li>${year}년 ${qMonths[0]} ~ ${year}년 ${qMonths[1]}</li></ul>
        <div class="apx-h">조사 권역</div>
        <div class="region-tags">
          <div class="rt"><span class="tag">CBD</span>종로구, 중구 및 서대문구(충정로) 일대</div>
          <div class="rt"><span class="tag">GBD</span>서초구, 강남구 일대</div>
          <div class="rt"><span class="tag">YBD</span>여의도 일대</div>
          <div class="rt"><span class="tag">BBD</span>성남시 분당구 및 수정구 일대</div>
          <div class="rt"><span class="tag">OTHERS</span>4대 업무권역 외 서울 일대</div>
        </div>
      </div>
      <div>
        <div class="apx-h">빌딩 등급 정보</div>
        <table class="grade-table">
          <thead><tr><th>분류 기준</th><th>등급 기준</th><th>조사 대상</th></tr></thead>
          <tbody>
            <tr class="hl"><td>프라임 (Prime)</td><td>연면적 66,116㎡ 이상</td><td>●</td></tr>
            <tr class="hl"><td>A급 (대형)</td><td>33,058㎡ 이상 ~ 66,116㎡ 미만</td><td>●</td></tr>
            <tr><td>B급 (중형)</td><td>16,529㎡ 이상 ~ 33,058㎡ 미만</td><td>—</td></tr>
            <tr><td>C급 (중소형)</td><td>9,917㎡ 이상 ~ 16,529㎡ 미만</td><td>—</td></tr>
            <tr><td>D급 (소형)</td><td>연면적 9,917㎡ 미만</td><td>—</td></tr>
          </tbody>
        </table>
      </div>
    </div>
    <div class="contact-grid">
      ${[
        { id:'qrCre1', label:'임대차 문의',        team:'CRE1(LRTR)',        name:'CRE1팀(TR), LR파트(LR)', desc:'임차인 대리(TR)·임대인 대리(LR)·사옥 컨설팅' },
        { id:'qrCre2', label:'매입매각 문의',      team:'CRE2(매입매각)',     name:'CRE2팀',                 desc:'오피스 매입·매각 자문·투자 자문·매각 주관' },
        { id:'qrSnr',  label:'업무 제휴/리서치 문의', team:'Strategy&Research', name:'Strategy & Research',    desc:'시장 리서치 데이터 협력 · 공동 자문 프로젝트 · 기관 투자자 자문' },
      ].map(c => `
      <div class="contact-card">
        <div class="c-label">${c.label}</div>
        <div class="c-name">${c.name}</div>
        <div class="c-desc">${c.desc}</div>
        <div class="c-qr" id="${c.id}" data-url="${esc(contactUrl(q, c.team))}"></div>
        <div class="c-hint">QR코드를 스캔하면 문의 페이지로 연결됩니다</div>
      </div>`).join('')}
    </div>
    <div class="disclaimer">
      <b>DISCLAIMER · 면책 조항</b><br>
      본 리포트는 S&amp;I Corp.의 내부 리서치 자료로 작성됨. 공실률·임대료·매매가 정보는 본사 자체 조사 및 시장 자료를 기반으로
      산출되었으며, 실제 거래 또는 의사결정 시 별도 확인이 필요함. <i>본 보고서의 무단 복제·배포·인용은 금지되며, 데이터 사용 시 사전 협의가 필요함.</i>
    </div>
  </div>`;
}

/* ── 17. 백커버 ── */
function pageBackCover() {
  // 원본 PDF 백커버 아트 (로고 포함 전체 페이지) — 파일 누락 시 로고만 폴백 표시
  return `
  <div class="mr-page backcover" style="padding:0">
    <img src="./mreport-back-bg.jpg" alt=""
         style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"
         onerror="this.style.display='none';this.nextElementSibling.style.display='block'">
    <div class="back-logo" style="display:none">${logoImg('52px')}</div>
  </div>`;
}

/* ═══════════════ 테이블 행 CRUD ═══════════════ */

function bindTableButtons(model) {
  document.querySelectorAll('.tbl-add-btn').forEach(btn => {
    btn.onclick = () => {
      const r = btn.dataset.region;
      if (btn.dataset.add === 'lease') model.regions[r].leases.push({ subRegion:'', building:'', areaPy:'', areaM2:'', tenant:'' });
      else                             model.regions[r].deals.push({ asset:'', price:'', pricePy:'', sellerBuyer:'' });
      collectModel(model);             // 편집 중이던 값 보존
      renderReport(model);
    };
  });
  document.querySelectorAll('button[data-del]').forEach(btn => {
    btn.onclick = () => {
      const tr = btn.closest('tr');
      const tbl = btn.closest('table');
      const path = tbl.dataset.tbl.split('.');       // ['regions','CBD','leases']
      collectModel(model);
      model[path[0]][path[1]][path[2]].splice(+tr.dataset.row, 1);
      renderReport(model);
    };
  });
}

/* ═══════════════ DOM → 모델 수집 ═══════════════ */

/** data-p 경로 문자열로 모델에 값 대입: "regions.CBD.points[1].body" */
function setByPath(model, path, value) {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.');
  let obj = model;
  for (let i = 0; i < parts.length - 1; i++) {
    if (obj[parts[i]] == null) obj[parts[i]] = /^\d+$/.test(parts[i + 1]) ? [] : {};
    obj = obj[parts[i]];
  }
  obj[parts[parts.length - 1]] = value;
}

/** 화면의 모든 편집 값을 모델로 회수 */
export function collectModel(model) {
  // 1) data-p 단일 필드
  document.querySelectorAll('[data-p]').forEach(el => {
    const raw = el.innerText.replace(/\u00a0/g, ' ').trim();
    if (el.dataset.p === '_coverPeriod') return;       // 표지 기간은 quarter에서 파생, 저장 불필요
    let val = raw;
    if (el.dataset.num) {                              // 공실률 숫자 필드: "2.94%" → 2.94
      const n = parseFloat(raw.replace(/[%\s]/g, ''));
      val = Number.isFinite(n) ? n : null;
    }
    setByPath(model, el.dataset.p, val);
  });
  // 2) 테이블
  document.querySelectorAll('table[data-tbl]').forEach(tbl => {
    const path = tbl.dataset.tbl.split('.');
    const rows = [];
    tbl.querySelectorAll('tbody tr').forEach(tr => {
      const row = {};
      tr.querySelectorAll('[data-c]').forEach(td => { row[td.dataset.c] = td.innerText.trim(); });
      rows.push(row);
    });
    model[path[0]][path[1]][path[2]] = rows;
  });
  return model;
}


/* ═══════════════ 문의 QR 코드 렌더 ═══════════════ */
function renderContactQRs() {
  document.querySelectorAll('.c-qr[data-url]').forEach(el => {
    el.innerHTML = '';
    const url = el.dataset.url;
    if (typeof QRCode !== 'undefined') {
      new QRCode(el, { text: url, width: 64, height: 64, correctLevel: QRCode.CorrectLevel.M });
    } else {
      // QR 라이브러리 미로드 시 폴백: 링크 텍스트
      el.innerHTML = `<a href="${esc(url)}" style="font-size:9px;word-break:break-all">${esc(url)}</a>`;
    }
  });
}
